import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Annotations, CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic, Subscription, SubscriptionProtocol } from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const AI_MODEL_ID = "ca.amazon.nova-lite-v1:0";
/** Regions the Canada inference profile routes to. */
export const AI_FOUNDATION_MODEL_REGIONS = ["ca-central-1", "ca-west-1"] as const;
export const AI_FOUNDATION_MODEL_ID = "amazon.nova-lite-v1:0";
export const GOOGLE_ISSUER = "https://accounts.google.com";

export interface TimeBlockerAiStackProps extends StackProps {
  /** Android OAuth client id(s), comma separated; the JWT audience. Falls back to context `googleClientId`. */
  googleClientId?: string;
  /** Comma separated Google `sub` values. Falls back to context `allowedSubs`. Empty denies everybody. */
  allowedSubs?: string;
  /** Falls back to context `budgetEmail`. When absent no Budget and no email subscription are created. */
  budgetEmail?: string;
  /** Test/CLI escape hatch: do not throw when googleClientId is missing (the caller reports it instead). */
  allowMissingGoogleClientId?: boolean;
}

export class TimeBlockerAiStack extends Stack {
  constructor(scope: Construct, id: string, props: TimeBlockerAiStackProps = {}) {
    super(scope, id, props);

    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    const googleClientId = str(props.googleClientId) ?? str(this.node.tryGetContext("googleClientId"));
    // One Android OAuth client per signing key (debug and release), comma separated.
    const googleClientIds = (googleClientId ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    for (const id of googleClientIds) {
      if (!id.endsWith(".apps.googleusercontent.com")) {
        throw new Error(`TimeBlockerAiStack: "${id}" is not a Google OAuth client id (expected ...apps.googleusercontent.com)`);
      }
    }
    const allowedSubs = str(props.allowedSubs) ?? str(this.node.tryGetContext("allowedSubs")) ?? "";
    const budgetEmail = str(props.budgetEmail) ?? str(this.node.tryGetContext("budgetEmail"));

    if (!googleClientId && !props.allowMissingGoogleClientId) {
      throw new Error(
        "TimeBlockerAiStack requires the Google OAuth client id: pass -c googleClientId=<id>.apps.googleusercontent.com",
      );
    }

    // ---------- Lambda ----------
    const logGroup = new LogGroup(this, "AiFunctionLogs", { retention: RetentionDays.TWO_WEEKS });
    // Explicit role (no AWSLambdaBasicExecutionRole): log write access to this group only, plus Bedrock invoke.
    const role = new Role(this, "AiFunctionRole", { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
    logGroup.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        sid: "InvokeNovaLiteCanadaProfile",
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:ca-central-1:${this.account}:inference-profile/${AI_MODEL_ID}`,
          ...AI_FOUNDATION_MODEL_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${AI_FOUNDATION_MODEL_ID}`),
        ],
      }),
    );

    const fn = new NodejsFunction(this, "AiFunction", {
      entry: path.join(here, "../ai/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(25),
      role,
      logGroup,
      environment: {
        ALLOWED_SUBS: allowedSubs,
        MODEL_ID: AI_MODEL_ID,
        // AWS_REGION is reserved and injected by the Lambda runtime (ca-central-1 for this stack).
      },
      bundling: {
        externalModules: ["@aws-sdk/*"],
        minify: true,
        sourceMap: false,
        target: "node22",
      },
    });

    // ---------- HTTP API ----------
    const api = new HttpApi(this, "AiApi", {
      apiName: "timeblocker-ai",
      createDefaultStage: false,
    });
    new HttpStage(this, "AiStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 2, burstLimit: 5 },
    });
    const authorizer = new HttpJwtAuthorizer("GoogleAuthorizer", GOOGLE_ISSUER, {
      jwtAudience: googleClientIds.length > 0 ? googleClientIds : ["MISSING_GOOGLE_CLIENT_ID"],
    });
    const integration = new HttpLambdaIntegration("AiIntegration", fn);
    for (const p of ["/ai/parse-tasks", "/ai/application-help"]) {
      api.addRoutes({ path: p, methods: [HttpMethod.POST], integration, authorizer });
    }

    // ---------- Cost and error guardrails ----------
    const topic = new Topic(this, "AiAlarmTopic", { displayName: "TimeBlocker AI alerts" });
    if (budgetEmail) {
      new Subscription(this, "AiAlarmEmail", {
        topic,
        protocol: SubscriptionProtocol.EMAIL,
        endpoint: budgetEmail,
      });
      new CfnBudget(this, "AiBudget", {
        budget: {
          budgetName: "timeblocker-ai-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: 5, unit: "USD" },
        },
        notificationsWithSubscribers: [50, 100].map((threshold) => ({
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: budgetEmail }],
        })),
      });
    } else {
      Annotations.of(this).addWarning(
        "budgetEmail context not set: no AWS Budget and no alarm email subscription were created. Pass -c budgetEmail=<email>.",
      );
    }

    const errors = new Alarm(this, "AiErrorsAlarm", {
      alarmName: "timeblocker-ai-errors",
      metric: fn.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    const invocations = new Alarm(this, "AiInvocationsAlarm", {
      alarmName: "timeblocker-ai-invocations-per-day",
      metric: fn.metricInvocations({ period: Duration.days(1), statistic: "Sum" }),
      threshold: 500,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    errors.addAlarmAction(new SnsAction(topic));
    invocations.addAlarmAction(new SnsAction(topic));

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint, description: "Base URL for AI_API_BASE_URL in the app." });
  }
}
