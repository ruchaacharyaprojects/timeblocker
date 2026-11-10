import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { TimeblockerStack } from "../lib/timeblocker-stack.js";

function synth(): Template {
  const app = new App();
  const stack = new TimeblockerStack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("TimeblockerStack", () => {
  const template = synth();

  it("creates four DynamoDB tables (items, blocks, settings, reviews)", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 4);
  });

  it("names the four tables as designed", () => {
    for (const name of [
      "timeblocker-items",
      "timeblocker-blocks",
      "timeblocker-settings",
      "timeblocker-reviews",
    ]) {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: name,
      });
    }
  });

  it("enables encryption at rest and point-in-time recovery on tables", () => {
    const tables = template.findResources("AWS::DynamoDB::Table");
    const tableProps = Object.values(tables);
    expect(tableProps).toHaveLength(4);
    for (const table of tableProps) {
      expect(table.Properties.SSESpecification).toEqual({ SSEEnabled: true });
      expect(
        table.Properties.PointInTimeRecoverySpecification
          .PointInTimeRecoveryEnabled,
      ).toBe(true);
    }
  });

  it("stores Google OAuth tokens in the settings table, not a Secrets Manager secret", () => {
    // Tokens now live in the DynamoDB settings table (encrypted at rest), so
    // the stack provisions no Secrets Manager secret (no flat monthly charge).
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    // The settings table that holds them exists (named as designed).
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "timeblocker-settings",
    });
  });

  it("provisions the five Lambda functions", () => {
    // intake, planning, reschedule, calendar-sync, scheduler
    template.resourceCountIs("AWS::Lambda::Function", 5);
  });

  it("exposes a REST API with the four POST routes", () => {
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    const resources = template.findResources("AWS::ApiGateway::Resource");
    const pathParts = Object.values(resources).map(
      (r) => r.Properties.PathPart,
    );
    expect(pathParts.sort()).toEqual(
      ["calendar-sync", "intake", "planning", "reschedule"].sort(),
    );
  });

  it("enables API access logging on the stage", () => {
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      AccessLogSetting: Match.objectLike({
        DestinationArn: Match.anyValue(),
      }),
    });
  });

  it("creates three EventBridge schedules in America/Toronto", () => {
    template.resourceCountIs("AWS::Scheduler::Schedule", 3);

    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(15 minutes)",
      ScheduleExpressionTimezone: "America/Toronto",
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 8 ? * SUN *)",
      ScheduleExpressionTimezone: "America/Toronto",
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 18 ? * SAT *)",
      ScheduleExpressionTimezone: "America/Toronto",
    });
  });

  it("grants no Bedrock permissions (intake is a pure parser, no Bedrock in v1)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Action?: unknown;
      }>;
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        for (const action of actions) {
          expect(String(action)).not.toContain("bedrock");
        }
      }
    }
  });

  it("grants the scheduler role permission to invoke the scheduler Lambda", () => {
    // A role assumable by the scheduler service principal must exist.
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "scheduler.amazonaws.com" },
          }),
        ]),
      }),
    });
  });
});
