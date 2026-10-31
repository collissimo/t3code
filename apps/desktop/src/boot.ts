require("./compileCache.cjs");
// Kept off the app's main: no lock, no server, no windows. See scrawl/scrawlCli.ts.
require(process.argv.includes("--scrawl") ? "./scrawlCli.cjs" : "./main.cjs");
