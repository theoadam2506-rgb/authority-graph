/** Runs the scripted agent demo and prints it. Run with: npm run demo:agent */
import { formatDemo, runAgentDemo } from "./scenarios.js";

console.log(formatDemo(await runAgentDemo()));
