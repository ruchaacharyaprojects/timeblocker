import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.join(__dirname, "..", "lambda");

/**
 * TimeBlocker serverless stack.
 *
 * Provisions the backend described in the design: API Gateway fronting four
 * Lambdas (intake, planning, reschedule, calendar sync), DynamoDB tables for
 * items / blocks / settings / reviews, and EventBridge Scheduler for the three
 * recurring jobs (15-min reminders, Sunday planning nudge, Saturday review).
 * Google OAuth tokens are stored in the DynamoDB settings table (encrypted at
 * rest) rather than Secrets Manager, so there is no Secrets Manager charge.
 * Intake parses a pasted/typed to-do list with a pure parser, so there is no
 * Bedrock usage.
 *
 * Secure defaults: all tables use AWS-managed encryption at rest and
 * point-in-time recovery; every IAM grant is least-privilege (scoped to the
 * specific table and action a function actually needs); API Gateway access
 * logging is enabled.
 */
export class TimeblockerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // DynamoDB tables: items, blocks, settings, reviews
    // ---------------------------------------------------------------------
    const tableDefaults = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    } satisfies Partial<dynamodb.TableProps>;

    // Items (R1): extracted/confirmed to-do items, keyed by week then item.
    const itemsTable = new dynamodb.Table(this, "ItemsTable", {
      tableName: "timeblocker-items",
      partitionKey: { name: "weekId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "itemId", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    // Blocks (R2/R4): placed time blocks, keyed by week then block.
    const blocksTable = new dynamodb.Table(this, "BlocksTable", {
      tableName: "timeblocker-blocks",
      partitionKey: { name: "weekId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "blockId", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    // Settings: single-user settings (distraction apps, planning mode,
    // holidays) plus the Google OAuth tokens (keyed `google-oauth-tokens`,
    // encrypted at rest with the table's AWS-managed key).
    const settingsTable = new dynamodb.Table(this, "SettingsTable", {
      tableName: "timeblocker-settings",
      partitionKey: { name: "settingKey", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    // Weekly review data (R9).
    const reviewsTable = new dynamodb.Table(this, "ReviewsTable", {
      tableName: "timeblocker-reviews",
      partitionKey: { name: "weekId", type: dynamodb.AttributeType.STRING },
      ...tableDefaults,
    });

    // ---------------------------------------------------------------------
    // Lambda functions
    // ---------------------------------------------------------------------
    const commonFnProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      handler: "handler",
      bundling: { minify: true, sourceMap: true },
    } satisfies Partial<
      ConstructorParameters<typeof NodejsFunction>[2]
    >;

    const makeFn = (id: string, dir: string, env: Record<string, string>) => {
      // Own the log group explicitly (one-month retention) instead of the
      // legacy `logRetention` prop, which provisions an extra custom-resource
      // Lambda. This keeps the function-to-log-group mapping least-privilege
      // and the deployed Lambda count equal to the number of handlers.
      const logGroup = new logs.LogGroup(this, `${id}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new NodejsFunction(this, id, {
        ...commonFnProps,
        entry: path.join(LAMBDA_ROOT, dir, "index.ts"),
        logGroup,
        environment: {
          ...env,
        },
      });
    };

    // Intake (R1): parses the pasted/typed to-do list, writes unconfirmed items.
    const intakeFn = makeFn("IntakeFn", "intake", {
      ITEMS_TABLE: itemsTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
    });

    // Planning (R2): runs the scheduling engine, writes blocks.
    const planningFn = makeFn("PlanningFn", "planning", {
      ITEMS_TABLE: itemsTable.tableName,
      BLOCKS_TABLE: blocksTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
    });

    // Intake confirms items then triggers planning (R1.3), so it needs the
    // planning function's name and permission to invoke it asynchronously.
    intakeFn.addEnvironment("PLANNING_FUNCTION_NAME", planningFn.functionName);
    planningFn.grantInvoke(intakeFn);

    // Reschedule (R6): moves a block to the next valid slot and updates its
    // Google Calendar event in place, so it needs the OAuth client config;
    // tokens themselves live in the DynamoDB settings table.
    const rescheduleFn = makeFn("RescheduleFn", "reschedule", {
      BLOCKS_TABLE: blocksTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? "",
    });

    // Calendar sync (R4/R6.1): reads the week's Google Calendar events, watches
    // for new meetings overlapping scheduled blocks, and raises the "Will you
    // miss this block?" prompt; a "Yes" answer routes into the shared
    // reschedule flow, so it needs the OAuth client config and the settings
    // table (holidays). PUSH_ENDPOINT is optional — when unset the function
    // logs the prompts it would raise, keeping the branch functional pre-push.
    const calendarSyncFn = makeFn("CalendarSyncFn", "calendar-sync", {
      BLOCKS_TABLE: blocksTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? "",
      PUSH_ENDPOINT: process.env.PUSH_ENDPOINT ?? "",
    });

    // Scheduler target (R5/R9): reminders, Sunday nudge, Saturday review.
    // The reminders branch (R5) reads the week's events from Google, so it
    // needs the OAuth client config; tokens themselves live in the DynamoDB
    // settings table. PUSH_ENDPOINT is optional — when unset the function logs the
    // reminders it would deliver, keeping the branch functional pre-push.
    const schedulerFn = makeFn("SchedulerFn", "scheduler", {
      BLOCKS_TABLE: blocksTable.tableName,
      REVIEWS_TABLE: reviewsTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? "",
      PUSH_ENDPOINT: process.env.PUSH_ENDPOINT ?? "",
    });

    // ---------------------------------------------------------------------
    // Least-privilege IAM grants
    // ---------------------------------------------------------------------
    // Intake only reads settings (planning mode, holidays); it does not touch
    // the Google OAuth tokens.
    itemsTable.grantReadWriteData(intakeFn);
    settingsTable.grantReadData(intakeFn);

    // The four Google-facing functions load the OAuth tokens from the settings
    // table and persist refreshed tokens back, so each needs read/write on it
    // (it also holds planning mode + holidays). This is the least privilege
    // now that tokens live in DynamoDB instead of a Secrets Manager secret.
    itemsTable.grantReadData(planningFn);
    blocksTable.grantReadWriteData(planningFn);
    settingsTable.grantReadWriteData(planningFn);

    blocksTable.grantReadWriteData(rescheduleFn);
    settingsTable.grantReadWriteData(rescheduleFn);

    blocksTable.grantReadWriteData(calendarSyncFn);
    settingsTable.grantReadWriteData(calendarSyncFn);

    blocksTable.grantReadWriteData(schedulerFn);
    reviewsTable.grantReadWriteData(schedulerFn);
    settingsTable.grantReadWriteData(schedulerFn);

    // ---------------------------------------------------------------------
    // API Gateway (R2.1 planning entrypoint + intake/reschedule/cal-sync)
    // ---------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, "ApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, "TimeblockerApi", {
      restApiName: "timeblocker-api",
      description: "TimeBlocker backend API (single user).",
      deployOptions: {
        stageName: "v1",
        accessLogDestination: new apigateway.LogGroupLogDestination(
          accessLogGroup,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
      },
    });

    const addPost = (
      pathPart: string,
      fn: lambda.IFunction,
    ): apigateway.Resource => {
      const resource = api.root.addResource(pathPart);
      resource.addMethod("POST", new apigateway.LambdaIntegration(fn));
      return resource;
    };

    addPost("intake", intakeFn);
    addPost("planning", planningFn);
    addPost("reschedule", rescheduleFn);
    addPost("calendar-sync", calendarSyncFn);

    // ---------------------------------------------------------------------
    // EventBridge Scheduler (R5 reminders, Sunday nudge, Saturday review)
    // ---------------------------------------------------------------------
    // Dedicated role the scheduler assumes to invoke the target Lambda,
    // scoped to exactly this function.
    const schedulerRole = new iam.Role(this, "SchedulerInvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description:
        "Lets EventBridge Scheduler invoke the TimeBlocker scheduler Lambda.",
    });
    schedulerFn.grantInvoke(schedulerRole);

    const TORONTO_TZ = "America/Toronto";

    const makeSchedule = (
      id: string,
      scheduleExpression: string,
      job: string,
      description: string,
    ) =>
      new scheduler.CfnSchedule(this, id, {
        description,
        scheduleExpression,
        scheduleExpressionTimezone: TORONTO_TZ,
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: schedulerFn.functionArn,
          roleArn: schedulerRole.roleArn,
          input: JSON.stringify({ job }),
        },
      });

    // 15-minute reminders: evaluate upcoming blocks/meetings every 15 minutes.
    makeSchedule(
      "RemindersSchedule",
      "rate(15 minutes)",
      "reminders",
      "Fires every 15 minutes to send custom block/meeting reminders (R5).",
    );

    // Sunday planning nudge: Sunday 08:00 America/Toronto.
    makeSchedule(
      "SundayPlanningNudge",
      "cron(0 8 ? * SUN *)",
      "sunday-planning-nudge",
      "Sunday morning nudge to plan the week (R9).",
    );

    // Saturday review: Saturday 18:00 America/Toronto.
    makeSchedule(
      "SaturdayReview",
      "cron(0 18 ? * SAT *)",
      "saturday-review",
      "Saturday evening weekly review (R9).",
    );
  }
}
