// 不安装插件也能验证 apply() 注册是否正常：用一个假 ctx 模拟 cordis 的最小接口。
import { apply } from "../index.js";

const tools = [];
const skills = [];
const ctx = {
  effect(fn) { return fn(); },
  tools: { register(t) { tools.push(t); return () => {}; } },
  inject(deps, cb) {
    if (deps.includes("skills")) cb({
      effect(fn) { return fn(); },
      skills: { registerProvider(p) { skills.push(p); return () => {}; } },
    });
  },
};

apply(ctx);
console.log("tools:", tools.map((t) => t.name).join(", "));
console.log("skills registered:", skills.length);

const st = tools.find((t) => t.name === "wechat_status");
const v = await st.execute({});
console.log("status.online =", v.online, "| wechat =", v.wechat);
console.log("render:", st.output.render({}, v)[0].text.split("\n")[0]);

const g = tools.find((t) => t.name === "wechat_guard");
console.log("guard(bad) =", JSON.stringify(await g.execute({ text: "C:\\Users\\example adb 1.2.3.4" })));
console.log("guard(ok)  =", JSON.stringify(await g.execute({ text: "晚上一起吃饭吗" })));

const sp = skills[0]();
const list = await sp.list();
console.log("skill list:", list.map((s) => s.name).join(","));
const sk = await sp.get({});
console.log("skill content starts:", sk.content.slice(0, 30).replace(/\n/g, " "));
