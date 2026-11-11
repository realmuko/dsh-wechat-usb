import * as core from "./core.js";

const cfg = core.loadConfig();
const [cmd, ...args] = process.argv.slice(2);

function out(v) {
  console.log(JSON.stringify(v, null, 2));
}

try {
  switch (cmd) {
    case "status":
      out(core.status(cfg));
      break;
    case "guard": {
      out(core.guard(cfg, args.join(" ")));
      break;
    }
    case "shot":
      out({ file: core.shot(cfg, args[0] || "cli") });
      break;
    case "home":
      out({ home: core.toHome(cfg) });
      break;
    case "open":
      out(core.openChat(cfg, args.join(" ")));
      break;
    case "send":
      out(core.sendText(cfg, args.join(" ")));
      break;
    case "watch":
      out({ frames: core.watch(cfg, Number(args[0] || 15), Number(args[1] || 3)) });
      break;
    case "ime-on":
      out({ ime: core.imeOn(cfg) });
      break;
    case "ime-off":
      out({ ime: core.imeOff(cfg) });
      break;
    default:
      console.log("usage: node lib/cli.js status|guard <text>|shot [label]|home|open <title>|send <text>|watch [intervalSec] [n]|ime-on|ime-off");
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
}
