import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedAgentSessions } from "../src/sessions/owned-sessions.js";
import type { AgentReply } from "../src/sessions/types.js";

const cli = process.env.IDEASPACES_TEST_CLI_BUNDLE;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function settle(sessions: OwnedAgentSessions, runId: string) {
  for (let i = 0; i < 200; i++) {
    const status = sessions.status({ runId });
    const last = status.runs[0].session.turns.at(-1);
    if (last && last.status !== "running" && last.status !== "pending") return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for CLI adapter turn");
}

// Explicit input bundle only: this public test has no dependency on a sibling checkout.
describe.skipIf(!cli || process.platform === "win32")("Pi extension → CLI → stand-in harnesses", () => {
  it("runs Pi and Claude in an unregistered Agreement repo, sends, resumes, and fails on auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "fellow-e2e-")); roots.push(root);
    const pov = join(root, "knowledge-repo"); mkdirSync(join(pov, "_agent"), { recursive: true });
    writeFileSync(join(pov, "_agent", "agreement.md"), "---\nname: Knowledge\n---\n# Agreement\n");
    const bin = join(root, "bin"); mkdirSync(bin);
    const piScript = join(bin, "fake-pi.cjs");
    writeFileSync(piScript, `
const fs=require('node:fs'),path=require('node:path'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PI_ARGS, JSON.stringify(args)+'\\n');
const id=args[args.indexOf('--session-id')+1];let buf='';
process.stdin.on('data',data=>{buf+=String(data);while(buf.includes('\\n')){
  const index=buf.indexOf('\\n');const raw=buf.slice(0,index);buf=buf.slice(index+1);if(!raw)continue;
  const c=JSON.parse(raw);
  if(c.type==='get_state')console.log(JSON.stringify({type:'response',command:'get_state',success:true,data:{sessionName:'Existing'}}));
  if(c.type==='prompt'){
    if(c.message.includes('auth_fail')){console.log(JSON.stringify({type:'response',command:'prompt',success:false,error:'Authentication failed'}));continue;}
    const dir=args[args.indexOf('--session-dir')+1],file=path.join(dir,'turn_'+id+'.jsonl');
    fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({type:'session',id,cwd:process.cwd()})+'\\n');
    fs.appendFileSync(file,JSON.stringify({type:'message',message:{role:'user',content:[{type:'text',text:c.message}]}})+'\\n');
    console.log(JSON.stringify({type:'response',command:'prompt',success:true}));
    console.log(JSON.stringify({type:'agent_start'}));console.log(JSON.stringify({type:'turn_start'}));
    console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'pi:'+c.message}}));
    console.log(JSON.stringify({type:'agent_end'}));
  }
}});
`);
    const claudeScript = join(bin, "fake-claude.cjs");
    writeFileSync(claudeScript, `
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS,JSON.stringify(args)+'\\n');
const id=args[args.indexOf('--session-id')+1]||args[args.indexOf('--resume')+1];
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
  const out=e=>console.log(JSON.stringify(e));out({type:'system',subtype:'init',session_id:id,model:'fake',cwd:process.cwd()});
  if(prompt.includes('auth_fail')){out({type:'result',subtype:'error_during_execution',is_error:true,errors:['Login required']});return;}
  const slug=process.cwd().replace(/[^a-zA-Z0-9]/gu,'-');const file=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',slug,id+'.jsonl');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,JSON.stringify({type:'user',sessionId:id,cwd:process.cwd(),message:{role:'user',content:prompt}})+'\\n');
  out({type:'stream_event',event:{type:'message_start'}});
  out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'claude:'+prompt}}});
  out({type:'result',subtype:'success',is_error:false,result:'claude:'+prompt,session_id:id,num_turns:1});
  fs.appendFileSync(file,JSON.stringify({type:'assistant',sessionId:id,message:{id:'m'+Date.now(),role:'assistant',content:[{type:'text',text:'claude:'+prompt}]}})+'\\n');
});
`);
    for (const [name, file] of [["pi", piScript], ["claude", claudeScript]]) {
      const wrapper = join(bin, name);
      writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`);
      chmodSync(wrapper, 0o755);
    }
    const previous = { PATH: process.env.PATH, IS_CLI_PATH: process.env.IS_CLI_PATH,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, IDEASPACES_PI_EXTENSIONS: process.env.IDEASPACES_PI_EXTENSIONS,
      FAKE_PI_ARGS: process.env.FAKE_PI_ARGS, FAKE_CLAUDE_ARGS: process.env.FAKE_CLAUDE_ARGS };
    const extension = join(root, "parent-extension.ts"); writeFileSync(extension, "export default () => {};\n");
    const skills = join(root, "parent-skills"); mkdirSync(skills);
    process.env.PATH = `${bin}:${previous.PATH}`;
    process.env.IS_CLI_PATH = cli!;
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
    delete process.env.IDEASPACES_PI_EXTENSIONS;
    process.env.FAKE_PI_ARGS = join(root, "pi-argv.jsonl");
    process.env.FAKE_CLAUDE_ARGS = join(root, "claude-argv.jsonl");
    const replies: AgentReply[] = [];
    const sessions = new OwnedAgentSessions({}, { deliver: (reply) => replies.push(reply) }, {
      resolveCliResources: () => ({ extensionPaths: [extension], skillPaths: [skills] }),
    });
    try {
      const pi = await sessions.start({ agent: pov, runtime: "pi", model: "fake/model", thinking: "high", message: "first" });
      expect((await settle(sessions, pi.run.session.runId)).reply).toBe("pi:first");
      const sent = await sessions.send({ runId: pi.run.session.runId, message: "second" });
      expect((await settle(sessions, sent.run.session.runId)).reply).toBe("pi:second");
      const argv = readFileSync(process.env.FAKE_PI_ARGS, "utf8").trim().split("\n").map((x) => JSON.parse(x) as string[]);
      expect(argv[0]).toEqual(expect.arrayContaining(["--model", "fake/model", "--thinking", "high", "--extension", realpathSync(extension), "--skill", realpathSync(skills), "--no-extensions"]));
      expect(argv[0]).not.toContain("--approve");
      expect(argv[0]).not.toContain("-a"); // saved trust, not implicit project approval
      const piId = sessions.status({ runId: pi.run.session.runId }).runs[0].session.sessionId!;
      expect(piId).toMatch(/^local-/);
      const piResume = await sessions.resume({ agent: pov, runtime: "pi", conversationId: piId, message: "third" });
      expect((await settle(sessions, piResume.run.session.runId)).reply).toBe("pi:third");
      await sessions.close(pi.run.session.runId);
      await sessions.close(piResume.run.session.runId);

      const claude = await sessions.start({ agent: pov, runtime: "claude", model: "sonnet", effort: "high", message: "hello" });
      expect((await settle(sessions, claude.run.session.runId)).reply).toBe("claude:hello");
      const claudeId = sessions.status({ runId: claude.run.session.runId }).runs[0].session.sessionId!;
      expect(claudeId).toMatch(/^[0-9a-f-]{36}$/);
      const resumed = await sessions.resume({ agent: pov, runtime: "claude", conversationId: claudeId,
        effort: "medium", message: "again" });
      expect((await settle(sessions, resumed.run.session.runId)).reply).toBe("claude:again");
      const claudeArgs = readFileSync(process.env.FAKE_CLAUDE_ARGS, "utf8").trim().split("\n").map((x) => JSON.parse(x) as string[]);
      expect(claudeArgs[0]).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "high",
        "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--permission-mode", "dontAsk"]));
      expect(claudeArgs[0]).not.toContain("--resume");
      expect(claudeArgs[1]).toEqual(expect.arrayContaining(["--resume", claudeId, "--effort", "medium", "--tools"]));
      const failed = await sessions.start({ agent: pov, runtime: "claude", message: "auth_fail" });
      expect((await settle(sessions, failed.run.session.runId)).status).toBe("failed");
      expect(replies.some((r) => r.error?.includes("Login required"))).toBe(true);
      await expect(sessions.start({ agent: pov, runtime: "claude", message: "do work", permissionMode: "bypassPermissions" }))
        .rejects.toThrow("requires readOnly:false");
      const writable = await sessions.start({ agent: pov, runtime: "claude", message: "do work",
        readOnly: false, permissionMode: "bypassPermissions" });
      expect((await settle(sessions, writable.run.session.runId)).reply).toBe("claude:do work");
      const lastArgs = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ARGS, "utf8").trim().split("\n").at(-1)!) as string[];
      expect(lastArgs).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
      expect(lastArgs).not.toContain("--tools");
    } finally {
      await sessions.shutdown();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 30_000);
});
