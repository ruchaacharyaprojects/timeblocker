import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { TimeBlockerAiStack, type TimeBlockerAiStackProps } from "../../lib/ai-stack.js";

const ACCOUNT = "123456789012";
const CLIENT_ID = "test.apps.googleusercontent.com";

function build(props: TimeBlockerAiStackProps = {}): Template {
  const app = new App();
  const stack = new TimeBlockerAiStack(app, "TimeBlockerAiStack", {
    env: { account: ACCOUNT, region: "ca-central-1" },
    googleClientId: CLIENT_ID,
    budgetEmail: "owner@example.com",
    ...props,
  });
  return Template.fromStack(stack);
}

describe("TimeBlockerAiStack", () => {
  const t = build({ allowedSubs: "sub-1, sub-2" });
  const json = t.toJSON() as { Resources: Record<string, { Type: string; Properties?: Record<string, any> }> };
  const ofType = (type: string) => Object.values(json.Resources).filter((r) => r.Type === type);

  it("JWT authorizer uses the Google issuer and the client id audience", () => {
    t.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: { Issuer: "https://accounts.google.com", Audience: [CLIENT_ID] },
    });
  });

  it("accepts both the debug-key and release-key OAuth clients as audiences", () => {
    const both = build({ googleClientId: "debug.apps.googleusercontent.com, release.apps.googleusercontent.com" });
    both.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      JwtConfiguration: {
        Issuer: "https://accounts.google.com",
        Audience: ["debug.apps.googleusercontent.com", "release.apps.googleusercontent.com"],
      },
    });
  });

  it("rejects a client id that is not a Google OAuth client id", () => {
    expect(() => build({ googleClientId: "debug.apps.googleusercontent.com,evil.example.com" })).toThrow(
      /not a Google OAuth client id/,
    );
  });

  it("has exactly two POST routes, both authorized, and no catch-all", () => {
    const routes = ofType("AWS::ApiGatewayV2::Route").map((r) => r.Properties!);
    expect(routes.map((r) => r.RouteKey).sort()).toEqual(["POST /ai/application-help", "POST /ai/parse-tasks"]);
    for (const r of routes) expect(r.AuthorizationType).toBe("JWT");
    const keys = routes.map((r) => String(r.RouteKey));
    expect(keys.some((k) => k.includes("$default") || k.includes("ANY") || k.includes("{proxy+}"))).toBe(false);
  });

  it("throttles the stage at 2 rps with burst 5", () => {
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
    });
    t.resourceCountIs("AWS::ApiGatewayV2::Stage", 1);
  });

  it("does not enable access logging", () => {
    const stage = ofType("AWS::ApiGatewayV2::Stage")[0]!.Properties!;
    expect(stage.AccessLogSettings).toBeUndefined();
  });

  it("configures the Lambda: Node 22, arm64, 256 MB, 25 s, no reserved concurrency (account quota is 10)", () => {
    t.resourceCountIs("AWS::Lambda::Function", 1);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 256,
      Timeout: 25,
      Environment: {
        Variables: { ALLOWED_SUBS: "sub-1, sub-2", MODEL_ID: "ca.amazon.nova-lite-v1:0" },
      },
    });
  });

  it("does not reserve Lambda concurrency (the account quota is 10, so any reservation would fail the deploy)", () => {
    const fns = t.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(fns)) {
      expect((fn as { Properties: Record<string, unknown> }).Properties).not.toHaveProperty("ReservedConcurrentExecutions");
    }
  });

  it("keeps logs for 14 days", () => {
    t.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
  });

  it("IAM: Bedrock invoke only on the profile and both foundation-model ARNs, no wildcards", () => {
    const policies = ofType("AWS::IAM::Policy");
    const statements = policies.flatMap((p) => p.Properties!.PolicyDocument.Statement as any[]);
    for (const s of statements) {
      const actions = ([] as string[]).concat(s.Action);
      for (const a of actions) expect(a).not.toContain("*");
      const resources = ([] as unknown[]).concat(s.Resource);
      for (const r of resources) expect(JSON.stringify(r)).not.toMatch(/"\*"|^"\*"$/);
    }
    const bedrock = statements.filter((s) => ([] as string[]).concat(s.Action).some((a) => a.startsWith("bedrock:")));
    expect(bedrock).toHaveLength(1);
    expect(([] as string[]).concat(bedrock[0].Action)).toEqual(["bedrock:InvokeModel"]);
    expect(bedrock[0].Effect).toBe("Allow");
    expect(bedrock[0].Resource).toEqual([
      `arn:aws:bedrock:ca-central-1:${ACCOUNT}:inference-profile/ca.amazon.nova-lite-v1:0`,
      "arn:aws:bedrock:ca-central-1::foundation-model/amazon.nova-lite-v1:0",
      "arn:aws:bedrock:ca-west-1::foundation-model/amazon.nova-lite-v1:0",
    ]);
  });

  it("the role has no managed policies and no inline wildcard statements", () => {
    const roles = ofType("AWS::IAM::Role");
    expect(roles).toHaveLength(1);
    expect(roles[0]!.Properties!.ManagedPolicyArns).toBeUndefined();
  });

  it("creates the budget (5 USD monthly, 50% and 100% ACTUAL to the email) when budgetEmail is given", () => {
    t.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 5, Unit: "USD" } },
      NotificationsWithSubscribers: [
        {
          Notification: { NotificationType: "ACTUAL", Threshold: 50, ThresholdType: "PERCENTAGE", ComparisonOperator: "GREATER_THAN" },
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "owner@example.com" }],
        },
        {
          Notification: { NotificationType: "ACTUAL", Threshold: 100, ThresholdType: "PERCENTAGE", ComparisonOperator: "GREATER_THAN" },
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "owner@example.com" }],
        },
      ],
    });
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "owner@example.com" });
  });

  it("alarms on Lambda errors and daily invocations, both notifying SNS", () => {
    t.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      Namespace: "AWS/Lambda",
      Statistic: "Sum",
      Period: 300,
      Threshold: 3,
      EvaluationPeriods: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      AlarmActions: [Match.anyValue()],
    });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Invocations",
      Namespace: "AWS/Lambda",
      Statistic: "Sum",
      Period: 86400,
      Threshold: 500,
      ComparisonOperator: "GreaterThanThreshold",
      AlarmActions: [Match.anyValue()],
    });
  });

  it("has no buckets, tables, or other public data resources", () => {
    for (const type of ["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::RDS::DBInstance", "AWS::SecretsManager::Secret", "AWS::Lambda::Url"]) {
      t.resourceCountIs(type, 0);
    }
  });

  it("outputs ApiUrl", () => {
    t.hasOutput("ApiUrl", {});
  });

  it("grants API Gateway permission only for the two AI route paths", () => {
    const perms = ofType("AWS::Lambda::Permission").map((p) => JSON.stringify(p.Properties!.SourceArn));
    expect(perms.length).toBeGreaterThanOrEqual(1);
    for (const p of perms) expect(p).toMatch(/\/ai\/(parse-tasks|application-help)"/);
  });
});

describe("TimeBlockerAiStack context handling", () => {
  it("denies everybody by default (empty ALLOWED_SUBS)", () => {
    build().hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { ALLOWED_SUBS: "" } },
    });
  });

  it("omits the budget and the email subscription (with a warning) when budgetEmail is missing", () => {
    const app = new App();
    const stack = new TimeBlockerAiStack(app, "NoEmail", {
      env: { account: ACCOUNT, region: "ca-central-1" },
      googleClientId: CLIENT_ID,
    });
    const t = Template.fromStack(stack);
    t.resourceCountIs("AWS::Budgets::Budget", 0);
    t.resourceCountIs("AWS::SNS::Subscription", 0);
    t.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    t.resourceCountIs("AWS::SNS::Topic", 1);
    const ann = Template.fromStack(stack); // synth done; check annotations via assembly
    expect(ann).toBeDefined();
    const messages = app
      .synth()
      .getStackByName("NoEmail")
      .messages.map((m) => m.entry.data as string);
    expect(messages.some((m) => /budgetEmail/.test(m))).toBe(true);
  });

  it("reads googleClientId, allowedSubs and budgetEmail from CDK context", () => {
    const app = new App({ context: { googleClientId: "ctx.apps.googleusercontent.com", allowedSubs: "abc", budgetEmail: "c@example.com" } });
    const t = Template.fromStack(new TimeBlockerAiStack(app, "Ctx", { env: { account: ACCOUNT, region: "ca-central-1" } }));
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      JwtConfiguration: { Audience: ["ctx.apps.googleusercontent.com"] },
    });
    t.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: { ALLOWED_SUBS: "abc" } } });
    t.resourceCountIs("AWS::Budgets::Budget", 1);
  });

  it("fails synth with a clear error when googleClientId is missing", () => {
    const app = new App();
    expect(() => new TimeBlockerAiStack(app, "NoClient", { env: { account: ACCOUNT, region: "ca-central-1" } })).toThrow(
      /googleClientId/,
    );
    expect(() => new TimeBlockerAiStack(new App(), "Blank", { googleClientId: "  " })).toThrow(/googleClientId/);
  });
});
