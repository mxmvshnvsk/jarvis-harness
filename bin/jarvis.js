#!/usr/bin/env node
import { run } from "../dist/cli/main.js";

run(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
