#!/usr/bin/env node
import { Annotations, App } from "aws-cdk-lib";
import { TimeblockerStack } from "../lib/timeblocker-stack.js";
import { TimeBlockerAiStack } from "../lib/ai-stack.js";
const app = new App();
new TimeblockerStack(app, "TimeblockerStack", {
  description: "TimeBlocker single-user serverless backend.",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});

// AI assistant backend (R32). Context: googleClientId (required to build/deploy), allowedSubs, budgetEmail.
// A missing googleClientId is reported as a stack error so only commands that select this stack fail;
// the legacy stack keeps its own context requirements.
const aiStack = new TimeBlockerAiStack(app, "TimeBlockerAiStack", {
  description: "TimeBlocker AI assistant: HTTP API + Lambda + Bedrock (Canada).",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
    region: "ca-central-1",
  },
  allowMissingGoogleClientId: true,
});
const clientId = aiStack.node.tryGetContext("googleClientId");
if (typeof clientId !== "string" || clientId.trim() === "") {
  Annotations.of(aiStack).addError(
    "TimeBlockerAiStack requires the Google OAuth client id: pass -c googleClientId=<id>.apps.googleusercontent.com",
  );
}
app.synth();
