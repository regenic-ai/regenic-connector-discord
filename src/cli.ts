#!/usr/bin/env node
import { ChannelDriverError } from "@regenic/connector-contract";
import { emitKeypressEvents } from "node:readline";
import { saveToken, removeToken } from "./secrets";

async function hiddenToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ChannelDriverError("invalid_config", "Token entry requires an interactive terminal; tokens are never accepted as command arguments.");
  }
  process.stdout.write("Bot token (hidden): ");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("keypress", keypress);
      process.stdin.off("end", cancelled);
      process.off("SIGTERM", cancelled);
      process.off("SIGINT", cancelled);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const cancelled = () => {
      cleanup();
      reject(new ChannelDriverError("invalid_config", "Token entry cancelled."));
    };
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        cancelled();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value);
      } else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && !/[\u0000-\u001f\u007f]/.test(text)) {
        if (value.length + text.length > 512) {
          cleanup();
          reject(new ChannelDriverError("invalid_config", "Token is too long."));
        } else value += text;
      }
    };
    process.stdin.on("keypress", keypress);
    process.stdin.once("end", cancelled);
    process.once("SIGTERM", cancelled);
    process.once("SIGINT", cancelled);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "token" || !["set", "remove"].includes(args[1]!) || !args[2]) {
    throw new ChannelDriverError("invalid_config", "Usage: regenic-discord token <set|remove> INSTALLATION_ID");
  }
  if (args[1] === "set") {
    await saveToken(args[2], await hiddenToken());
    process.stdout.write("Bot token saved in the system credential store.\n");
  } else {
    await removeToken(args[2]);
    process.stdout.write("System credential entry removed (if present).\n");
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof ChannelDriverError ? error.message : "Discord local credential operation failed."}\n`);
  process.exitCode = 1;
});
