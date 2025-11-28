#!/usr/bin/env node

import { Command } from "commander";
import { appendFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { Browserbase } from "@browserbasehq/sdk";
import type { LogLine } from "@browserbasehq/stagehand";
import { Stagehand } from "@browserbasehq/stagehand";

interface CLIOptions {
    region: string;
    bbApiKey?: string;
    bbProjectId?: string;
    modelApiKey?: string;
    model: string;
    outputDir: string;
    systemPrompt: string;
}

const writeOutputFile = async (outputDir: string, fileName: string, content: object): Promise<void> => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, fileName), JSON.stringify(content, null, 2), "utf-8");
};

const getEnvVar = (cliValue: string | undefined, envKey: string): string => {
    const value = cliValue ?? process.env[envKey];
    if (!value) {
        throw new Error(`Missing required config: provide --${envKey.toLowerCase().replace(/_/g, '-')} or set ${envKey}`);
    }
    return value;
};

const runAgent = async (instruction: string, options: CLIOptions): Promise<void> => {
    const apiKey = getEnvVar(options.bbApiKey, "BROWSERBASE_API_KEY");
    const projectId = getEnvVar(options.bbProjectId, "BROWSERBASE_PROJECT_ID");
    const modelApiKey = getEnvVar(options.modelApiKey, "MODEL_API_KEY");

    const browserbase = new Browserbase({ apiKey });

    let sessionId: string | undefined;
    let logFilePath: string | undefined;

    const appendLog = async (logLine: LogLine): Promise<void> => {
        if (!logFilePath) return;
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${JSON.stringify(logLine)}\n`;
        await appendFile(logFilePath, line, "utf-8").catch(() => { });
    };

    const stagehand = new Stagehand({
        env: "BROWSERBASE",
        browserbaseSessionCreateParams: {
            region: options.region as "us-west-2" | "us-east-1" | "eu-central-1" | "ap-southeast-1",
            browserSettings: { blockAds: true },
        },
        apiKey,
        projectId,
        model: { modelName: options.model, apiKey: modelApiKey },
        disablePino: true,
        logger: (logLine) => { appendLog(logLine); },
    });

    try {
        await stagehand.init();

        sessionId = stagehand.browserbaseSessionID!;

        // Initialize log file
        await mkdir(options.outputDir, { recursive: true });
        logFilePath = join(options.outputDir, `session-${sessionId}-logs.txt`);

        const { debuggerFullscreenUrl: sessionLiveUrl } = await browserbase.sessions.debug(sessionId);

        // Write start file in background - don't await
        const startPromise = writeOutputFile(
            options.outputDir,
            `session-${sessionId}-start.json`,
            { instruction, sessionId, sessionLiveUrl, startedAt: new Date().toISOString() }
        );

        const result = await stagehand.agent({ systemPrompt: options.systemPrompt }).execute({ instruction });

        // Ensure start file is written, then write result
        await startPromise;
        await writeOutputFile(
            options.outputDir,
            `session-${sessionId}-result.json`,
            { ...result, completedAt: new Date().toISOString() }
        );
    } finally {
        await stagehand.close().catch(() => { });
    }
};

new Command()
    .name("aicerts-web-agent")
    .description("AI-powered browser automation agent")
    .version("1.0.0")
    .argument("<instruction>", "The instruction for the agent to execute")
    .option("-r, --region <region>", "Browserbase region", "ap-southeast-1")
    .option("-b, --bb-api-key <key>", "Browserbase API key (or BROWSERBASE_API_KEY env)")
    .option("-p, --bb-project-id <id>", "Browserbase Project ID (or BROWSERBASE_PROJECT_ID env)")
    .option("-k, --model-api-key <key>", "AI Model API key (or MODEL_API_KEY env)")
    .option("-m, --model <model>", "AI Model", "google/gemini-2.5-pro")
    .option("-o, --output-dir <dir>", "Output directory", "./output")
    .option("-s, --system-prompt <prompt>", "System prompt for the agent", "You're a helpful assistant that can control a web browser.")
    .action(async (instruction: string, options: CLIOptions) => {
        try {
            await runAgent(instruction, options);
        } catch (error) {
            console.error("Error:", error instanceof Error ? error.message : error);
            process.exit(1);
        }
    })
    .parse();

// 