/**
 * upload-bundle.mjs — 打包 session 文件为 zip 并上传
 *
 * 打包结构:
 *   manifest.json                         ← 组件清单（converter 自用，ca-viewer 忽略）
 *   meta.json                             ← 工作流绑定（ca-viewer 必需）
 *   snapshot.json                         ← 工作流定义快照（ca-viewer 必需）
 *   <session-id>.jsonl                     ← 主 transcript
 *   <session-id>/subagents/agent-*.jsonl   ← 子 agent
 *   <session-id>/session-memory/*.jsonl    ← session memory
 *   run-state/<run-id>/                    ← run 目录（仅当前 session 的）
 *
 * 上传目标:
 *   config.uploadUrl: multipart 或 raw 模式 — 保存 zip 到服务器
 *
 * 打包方式: yazl (跨平台, UTF-8 安全, 无系统命令依赖)
 */

import { readFileSync, readdirSync, statSync, lstatSync, existsSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";
import yazl from "yazl";

// 单文件大小限制：50MB，超过则跳过并记录警告
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * 从本地插件任务文件解析"该步骤可用 skills"列表。
 * taskFile 形如 tasks/step-xxx.md，同机插件目录下可读（插件 tasks 目录）。
 * 与 ca-viewer runStateParser.resolveTaskFileSkills 保持一致。
 */
function resolveTaskFileSkills(taskFile) {
  try {
    if (!taskFile) return [];
    const baseName = taskFile.split('/').pop() ?? taskFile;
    const globRoot = join(homedir(), '.legacy-state', 'plugins', 'cache', 'aimarket');
    if (!existsSync(globRoot)) return [];
    const pluginDirs = readdirSync(globRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const plugin of pluginDirs) {
      // 插件目录可能带版本层：<plugin>/tasks/ 或 <plugin>/<version>/tasks/
      const tasksDirs = [
        join(globRoot, plugin, 'tasks'),
        ...(existsSync(join(globRoot, plugin))
          ? readdirSync(join(globRoot, plugin), { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => join(globRoot, plugin, d.name, 'tasks'))
          : []),
      ];
      for (const tasksDir of tasksDirs) {
        const candidate = join(tasksDir, baseName);
        if (!existsSync(candidate)) continue;
        const content = readFileSync(candidate, 'utf8');
        const m = content.match(/可用 skills\s*[:：]\s*(\[[^\]]*\]|\"[^\"]*\")/);
        if (!m) return [];
        const raw = m[1].trim();
        if (raw.startsWith('[')) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed.filter((x) => typeof x === 'string' && x.trim().length > 0);
          }
        }
        return raw
          .replace(/^"|"$/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    return [];
  } catch {
    return [];
  }
}

function addDirToZip(zipfile, dir, zipPath, warnings) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    warnings.push(`Cannot read dir ${dir}: ${e.message}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const entryPath = join(zipPath, entry);

    // 使用 lstatSync 检测符号链接
    let lst;
    try {
      lst = lstatSync(fullPath);
    } catch (e) {
      warnings.push(`Cannot stat ${fullPath}: ${e.message}`);
      continue;
    }

    // 跳过符号链接（防止循环引用和路径穿越）
    if (lst.isSymbolicLink()) {
      warnings.push(`Skipping symlink: ${fullPath}`);
      continue;
    }

    if (lst.isDirectory()) {
      addDirToZip(zipfile, fullPath, entryPath, warnings);
    } else if (lst.isFile()) {
      // 检查文件大小
      if (lst.size > MAX_FILE_SIZE) {
        warnings.push(`Skipping large file (${(lst.size / 1024 / 1024).toFixed(1)}MB): ${fullPath}`);
        continue;
      }
      try {
        zipfile.addBuffer(readFileSync(fullPath), entryPath, { compress: true });
      } catch (e) {
        warnings.push(`Cannot read file ${fullPath}: ${e.message}`);
      }
    }
  }
}

// ── 从 run-state 数据生成 meta.json ──────────────────────
// ca-viewer 期望的 meta.json 格式:
// {
//   "sessionId": "<session-id>",
//   "binding": {
//     "workflowRunId": "<run-id>",
//     "steps": [
//       { "nodeRunId": "<step-id>", "startedAt": "...", "completedAt": "..." },
//       ...
//     ]
//   }
// }
function generateMetaJson(state, sessionId, eventsJsonl, workflowYaml) {
  const runId = state.run_id;
  if (!runId) return null;

  // 从 events.jsonl 提取步骤时间窗口
  const stepTimestamps = {};
  if (eventsJsonl) {
    const lines = eventsJsonl.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.kind === "step" && event.step?.id && event.time) {
          const stepId = event.step.id;
          if (!stepTimestamps[stepId]) stepTimestamps[stepId] = {};
          if (event.event === "started") stepTimestamps[stepId].startedAt = event.time;
          else if (event.event === "completed") stepTimestamps[stepId].completedAt = event.time;
        }
      } catch {}
    }
  }

  // 来源 1：从 state.steps 提取步骤列表（兼容数组和对象两种格式）
  const stepsArr = Array.isArray(state.steps)
    ? state.steps
    : state.steps
      ? Object.entries(state.steps).map(([id, s]) => ({ ...s, id }))
      : [];

  let steps = stepsArr
    .filter(s => s.id)
    .map(s => {
      const ts = stepTimestamps[s.id] || {};
      return {
        nodeRunId: s.id,
        ...(ts.startedAt ? { startedAt: ts.startedAt } : {}),
        ...(ts.completedAt ? { completedAt: ts.completedAt } : {}),
      };
    });

  // 来源 2：state.steps 为空时，从 events.jsonl 的步骤事件提取
  if (steps.length === 0 && Object.keys(stepTimestamps).length > 0) {
    steps = Object.entries(stepTimestamps).map(([stepId, ts]) => ({
      nodeRunId: stepId,
      ...(ts.startedAt ? { startedAt: ts.startedAt } : {}),
      ...(ts.completedAt ? { completedAt: ts.completedAt } : {}),
    }));
  }

  // 来源 3：events.jsonl 也没有时，从 workflow.yaml 提取 step IDs
  if (steps.length === 0 && workflowYaml) {
    const stepIds = [];
    for (const line of workflowYaml.split(/\r?\n/)) {
      const m = /^\s+id:\s*(step-\S+)/.exec(line);
      if (m) stepIds.push(m[1]);
    }
    steps = stepIds.map(stepId => ({ nodeRunId: stepId }));
  }

  return {
    sessionId,
    binding: {
      workflowRunId: runId,
      ...(steps.length ? { steps } : {}),
    },
  };
}

// ── 从 workflow.yaml 生成 snapshot.json ──────────────────
// ca-viewer 期望的 snapshot.json 格式（WorkflowRunSnapshot）:
// 必须通过 isSnapshot 验证: schemaVersion===1, runId/workflowId/workflowVersion 为 string, steps 为 Array
// {
//   "schemaVersion": 1,
//   "workflowId": "...",
//   "workflowName": "...",
//   "workflowVersion": "...",
//   "runId": "...",
//   "createdAt": "...",
//   "steps": [
//     { "stepId": "step-xxx", "name": "...", "applicable": true, "expectations": [...], "next": "step-yyy" }
//   ]
// }
// 逻辑移植自 ca-viewer/src/main/services/import/runStateParser.ts generateSnapshot()
function generateSnapshotJson(state, workflowYaml) {
  if (!workflowYaml) return null;
  try {
    // configStudio 生成的 workflow.yaml 是 CRLF 行尾，split('\n') 残留 \r 会导致
    // name/skill 正则匹配失败。统一用 /\r?\n/ 分割。
    const lines = workflowYaml.split(/\r?\n/);

    // 预编译正则——与 runStateParser.ts 保持一致
    const RE_WORKFLOW_ID = /^\s+id:\s*(\S+)/;
    const RE_WORKFLOW_NAME = /^[  ]+name:[  ]+(\S[^\r\n]*)$/;
    const RE_WORKFLOW_VERSION = /^\s+version:\s*(\S+)/;
    const RE_STEP_ID = /^\s+id:\s*(step-\S+)/;
    const RE_STEP_NAME = /^[  ]+name:[  ]+(\S[^\r\n]*)$/;
    const RE_STEP_SKILL = /^\s+skill:\s+(\S+)/;
    const RE_STEP_USE_SUBAGENT = /^\s+use_subagent:\s*true/;
    const RE_OUTPUT_PATH = /^\s+-\s+`([^`]+)`/;
    const RE_TASK_FILE = /^\s+taskFile:\s*(\S+)/;
    const RE_PROMPT_SKILLS = /该步骤可用 skills:\s*\[([^\]]*)\]/;
    const RE_CONFIGURED_SKILLS = /^\s+configuredSkills:/;
    const RE_LIST_ITEM = /^\s+-\s+(.+?)\r?$/;
    const RE_NEXT_STEP = /^\s+id:\s*step-/;
    const RE_TOP_LEVEL = /^\S/;

    // 提取顶层 workflow 元信息
    const workflow = { id: "", name: "", version: "" };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = RE_WORKFLOW_ID.exec(line);
      if (m && !workflow.id) workflow.id = m[1];
      const nm = RE_WORKFLOW_NAME.exec(line);
      if (nm && !workflow.name && i < 20) workflow.name = nm[1].trim();
      const vm = RE_WORKFLOW_VERSION.exec(line);
      if (vm && !workflow.version) workflow.version = vm[1];
    }

    // 逐行解析步骤定义（状态机）——与 runStateParser.ts generateSnapshot 一致
    const parsedSteps = [];
    let i = 0;
    while (i < lines.length) {
      const stepMatch = RE_STEP_ID.exec(lines[i]);
      if (!stepMatch) {
        i++;
        continue;
      }

      const step = {
        id: stepMatch[1],
        name: "",
        skill: "",
        taskFile: "",
        promptSkills: [],
        configuredSkills: [],
        useSubagent: false,
        outputs: [],
      };

      let inOutputs = false;
      let inConfigured = null;

      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];

        // 下一个 step 开始 → 结束当前 step
        if (RE_NEXT_STEP.test(line)) {
          i = j;
          break;
        }
        // 下一个顶层键 → 结束当前 step
        if (RE_TOP_LEVEL.test(line)) {
          i = j;
          break;
        }

        // name
        const nm = RE_STEP_NAME.exec(line);
        if (nm) step.name = nm[1].trim();

        // skill
        const sm = RE_STEP_SKILL.exec(line);
        if (sm) step.skill = sm[1];

        // use_subagent
        if (RE_STEP_USE_SUBAGENT.test(line)) {
          step.useSubagent = true;
        }

        // taskFile（步骤任务文件，含"该步骤可用 skills"声明）
        const tf = RE_TASK_FILE.exec(line);
        if (tf) step.taskFile = tf[1];

        // prompt 内联声明的多 skill 列表（prompt-inline 模式，无 taskFile）
        const pskMatch = RE_PROMPT_SKILLS.exec(line);
        if (pskMatch) {
          const raw = pskMatch[1];
          const skills = raw
            .split(',')
            .map((s) => s.trim().replace(/[\\\"']/g, '').trim())
            .filter((s) => s.length > 0);
          for (const skill of skills) {
            if (!step.promptSkills.includes(skill)) {
              step.promptSkills.push(skill);
            }
          }
        }

        // configuredSkills（步骤配置的多能力清单，converter 显式输出）
        if (RE_CONFIGURED_SKILLS.test(line)) { inConfigured = 'configuredSkills'; continue; }
        if (inConfigured) {
          const li = RE_LIST_ITEM.exec(line);
          if (li) {
            const val = li[1].replace(/["']/g, '').trim();
            if (val && !step.configuredSkills.includes(val)) step.configuredSkills.push(val);
          } else if (line.trim() && !/^\s/.test(line)) {
            inConfigured = null; // 列表结束
          }
          continue;
        }

        // prompt 内容——检测 "## 正式输出" 段
        if (line.includes("## 正式输出")) {
          inOutputs = true;
          continue;
        }
        if (line.includes("## ") && inOutputs) {
          inOutputs = false;
          continue;
        }

        // 在"正式输出"段内，提取反引号路径
        if (inOutputs) {
          const pathMatch = RE_OUTPUT_PATH.exec(line);
          if (pathMatch) {
            let raw = pathMatch[1].replace(/'/g, "");
            // 去掉条件说明（中文括号后的内容）
            const parenIdx = raw.indexOf("（");
            if (parenIdx >= 0) {
              raw = raw.slice(0, parenIdx);
            }
            raw = raw.trim();
            // 去掉公共前缀
            const prefix = "specs/<AR-ID>/";
            if (raw.startsWith(prefix)) {
              raw = raw.slice(prefix.length);
            }
            if (raw.includes("/") && raw.length > 3) {
              step.outputs.push(raw);
            }
          }
        }

        if (j === lines.length - 1) {
          i = j + 1;
        }
      }

      parsedSteps.push(step);
    }

    // 从步骤定义生成 expectations ——与 runStateParser.ts 一致
    const snapshotSteps = parsedSteps.map((step, index) => {
      const expectations = [];

      // skill 期望：主 skill（required）+ taskFile/prompt 辅助 skill 列表（required=false）
      const declaredPrimary = step.skill ? [step.skill] : [];
      const declaredAux = [];
      for (const skill of resolveTaskFileSkills(step.taskFile)) {
        if (skill !== step.skill && !declaredAux.includes(skill)) declaredAux.push(skill);
      }
      for (const skill of step.promptSkills) {
        if (skill !== step.skill && !declaredAux.includes(skill)) declaredAux.push(skill);
      }
      for (const skill of declaredPrimary) {
        expectations.push({
          id: `skill-${step.id}-${skill.replace(/[^a-zA-Z0-9]/g, "-")}`,
          kind: "skill",
          match: skill,
          required: true,
          evidenceSource: "transcript",
          label: skill,
        });
      }
      for (const skill of declaredAux) {
        expectations.push({
          id: `skill-${step.id}-${skill.replace(/[^a-zA-Z0-9]/g, "-")}`,
          kind: "skill",
          match: skill,
          required: false,
          evidenceSource: "transcript",
          label: skill,
        });
      }
      // configuredSkills 期望（与主/辅 skill 去重）
      for (const skill of (step.configuredSkills || []).filter(
        (s) => s !== step.skill && !declaredAux.includes(s)
      )) {
        expectations.push({
          id: `skill-${step.id}-${skill.replace(/[^a-zA-Z0-9]/g, "-")}`,
          kind: "skill",
          match: skill,
          required: false,
          evidenceSource: "transcript",
          label: skill,
        });
      }

      // agent 期望（use_subagent: true 的步骤）
      if (step.useSubagent) {
        expectations.push({
          id: `agent-${step.id}`,
          kind: "agent",
          match: "Agent",
          required: true,
          evidenceSource: "transcript",
          label: "子 Agent 评审",
        });
      }

      // output 期望
      for (const output of step.outputs) {
        expectations.push({
          id: `output-${step.id}-${output.replace(/[^a-zA-Z0-9]/g, "-")}`,
          kind: "output",
          match: output,
          required: true,
          evidenceSource: "transcript",
          label: output,
        });
      }

      return {
        stepId: step.id,
        name: step.name,
        applicable: true,
        expectations,
        ...(index + 1 < parsedSteps.length ? { next: parsedSteps[index + 1].id } : {}),
      };
    });

    // 返回符合 WorkflowRunSnapshot 接口的对象
    // isSnapshot 验证要求: schemaVersion===1, runId/workflowId/workflowVersion 为 string, steps 为 Array
    return {
      schemaVersion: 1,
      workflowId: workflow.id || state.workflow_id || "",
      workflowVersion: workflow.version || "",
      workflowName: workflow.name || "",
      runId: state.run_id || "",
      createdAt: state.started_at || new Date().toISOString(),
      steps: snapshotSteps,
    };
  } catch (err) {
    console.error("[upload-bundle] snapshot generation failed:", err);
    return null;
  }
}

export async function uploadBundle(sessions, manifest, config, runDir) {
  const warnings = [];
  const logPrefix = "[upload-bundle]";

  // 1. 创建 zip
  const zipfile = new yazl.ZipFile();

  // 2. 写 manifest.json（converter 自用，ca-viewer 忽略）
  zipfile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"), "manifest.json", { compress: true });

  // 3. 读取 run-state 数据，生成 meta.json 和 snapshot.json
  const runId = basename(runDir);
  let state = null;
  let workflowYaml = null;
  let eventsJsonl = null;

  console.log(`${logPrefix} runDir=${runDir}, runId=${runId}, sessions=${sessions.length}`);

  if (existsSync(runDir)) {
    // 读取 state.json
    const statePath = join(runDir, "state.json");
    if (existsSync(statePath)) {
      try {
        state = JSON.parse(readFileSync(statePath, "utf-8"));
        console.log(`${logPrefix} state.json loaded: run_id=${state.run_id}, status=${state.status}, workflow_id=${state.workflow_id}`);
      } catch (e) {
        warnings.push(`Cannot parse state.json: ${e.message}`);
        console.error(`${logPrefix} state.json parse failed: ${e.message}`);
      }
    } else {
      console.warn(`${logPrefix} state.json not found at ${statePath}`);
    }

    // 读取 workflow.yaml
    const wfPath = join(runDir, "workflow.yaml");
    if (existsSync(wfPath)) {
      try {
        workflowYaml = readFileSync(wfPath, "utf-8");
        console.log(`${logPrefix} workflow.yaml loaded: ${workflowYaml.length} bytes`);
      } catch (e) {
        warnings.push(`Cannot read workflow.yaml: ${e.message}`);
        console.error(`${logPrefix} workflow.yaml read failed: ${e.message}`);
      }
    } else {
      console.warn(`${logPrefix} workflow.yaml not found at ${wfPath}`);
    }

    // 读取 trace/events.jsonl
    const eventsPath = join(runDir, "trace", "events.jsonl");
    if (existsSync(eventsPath)) {
      try {
        eventsJsonl = readFileSync(eventsPath, "utf-8");
        console.log(`${logPrefix} events.jsonl loaded: ${eventsJsonl.length} bytes`);
      } catch (e) {
        warnings.push(`Cannot read events.jsonl: ${e.message}`);
        console.error(`${logPrefix} events.jsonl read failed: ${e.message}`);
      }
    } else {
      console.warn(`${logPrefix} events.jsonl not found at ${eventsPath}`);
    }
  } else {
    console.warn(`${logPrefix} runDir does not exist: ${runDir}`);
  }

  // 生成 meta.json（ca-viewer 必需 — 工作流绑定）
  // 优先使用实际上传的 session id（多 run 切片时为派生 id <sessionId>_<runId>），
  // 保证 meta.json 的 sessionId 与 zip 内 transcript 文件名一致，服务端绑定才能命中。
  const sessionId = sessions[0]?.sessionId || manifest.run?.session_id || state?.session_id || "";
  if (state && sessionId) {
    const meta = generateMetaJson(state, sessionId, eventsJsonl, workflowYaml);
    if (meta) {
      zipfile.addBuffer(Buffer.from(JSON.stringify(meta, null, 2), "utf-8"), "meta.json", { compress: true });
      console.log(`${logPrefix} meta.json generated: sessionId=${sessionId}, workflowRunId=${meta.binding?.workflowRunId}, steps=${meta.binding?.steps?.length ?? 0}`);
    } else {
      console.warn(`${logPrefix} meta.json generation returned null — ca-viewer will use fallback`);
    }
  } else {
    console.warn(`${logPrefix} meta.json skipped: state=${!!state}, sessionId=${sessionId || "(empty)"}`);
  }

  // 生成 snapshot.json（ca-viewer 必需 — 工作流定义快照）
  if (state && workflowYaml) {
    const snapshot = generateSnapshotJson(state, workflowYaml);
    if (snapshot) {
      zipfile.addBuffer(Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8"), "snapshot.json", { compress: true });
      console.log(`${logPrefix} snapshot.json generated: workflowName="${snapshot.workflowName}", workflowVersion="${snapshot.workflowVersion}", workflowId="${snapshot.workflowId}", steps=${snapshot.steps?.length ?? 0}`);
      if (!snapshot.workflowName || (snapshot.steps?.length ?? 0) === 0) {
        console.warn(`${logPrefix} ⚠ snapshot.json has empty fields — check workflow.yaml parsing (possible regex escape issue)`);
      }
    } else {
      console.warn(`${logPrefix} snapshot.json generation returned null — ca-viewer will use fallback`);
    }
  } else {
    console.warn(`${logPrefix} snapshot.json skipped: state=${!!state}, workflowYaml=${!!workflowYaml}`);
  }

  // 4. 添加 session 文件
  for (const sess of sessions) {
    // 主 JSONL → 根目录 <sessionId>.jsonl
    zipfile.addBuffer(readFileSync(sess.jsonlPath), sess.jsonlFile, { compress: true });

    // subagents → <sessionId>/subagents/agent-*.jsonl
    if (sess.subagentFiles && sess.subagentFiles.length) {
      for (const sf of sess.subagentFiles) {
        zipfile.addBuffer(readFileSync(sf.path), join(sess.sessionId, "subagents", sf.name), { compress: true });
      }
    }

    // session-memory → <sessionId>/session-memory/
    if (sess.memFiles && sess.memFiles.length) {
      for (const mf of sess.memFiles) {
        zipfile.addBuffer(readFileSync(mf.path), join(sess.sessionId, "session-memory", mf.name), { compress: true });
      }
    }
  }

  // 5. 复制 run 目录（仅当前 session 的 run-state，防止旧数据聚合）
  if (existsSync(runDir)) {
    addDirToZip(zipfile, runDir, join("run-state", runId), warnings);
  }

  // 6. 收集 zip buffer
  const zipChunks = [];
  zipfile.outputStream.on("data", (chunk) => zipChunks.push(chunk));
  const zipPromise = new Promise((resolve, reject) => {
    zipfile.outputStream.on("end", () => resolve(Buffer.concat(zipChunks)));
    zipfile.outputStream.on("error", reject);
  });
  zipfile.end();
  const zipBuffer = await zipPromise;

  console.log(`${logPrefix} zip built: ${zipBuffer.length} bytes`);

  // 7. 上传
  const result = await doUpload(zipBuffer, manifest, config);
  console.log(`${logPrefix} upload result: ok=${result.ok}, status=${result.status}`);
  if (!result.ok) {
    console.error(`${logPrefix} upload failed: ${result.body?.slice(0, 300)}`);
  } else {
    try {
      const resp = JSON.parse(result.body);
      const imp = resp.imports?.[0];
      if (imp) {
        console.log(`${logPrefix} server response: importId=${imp.importId}, hasMeta=${imp.hasMeta}, workflowRunId=${imp.workflowRunId}, subagentCount=${imp.subagentCount}, warnings=${imp.warnings?.length ?? 0}`);
      }
    } catch {}
  }
  if (warnings.length > 0) {
    result.warnings = warnings;
    console.warn(`${logPrefix} warnings: ${warnings.join("; ")}`);
  }
  return result;
}

async function doUpload(fileBuffer, manifest, config) {
  const logPrefix = "[upload-bundle]";
  // 上传到 /api/imports 接口（uploadUrl 为 baseUrl，追加端点路径）
  const baseUrl = (config.uploadUrl || "").replace(/[/]+$/g, "");
  const url = baseUrl + "/api/imports";
  const mode = config.uploadMode || "raw";
  const headers = config.uploadHeaders || {};

  console.log(`${logPrefix} doUpload: mode=${mode}, url=${url}, zipSize=${fileBuffer.length} bytes`);
  console.log(`${logPrefix} doUpload: uploadFields=${JSON.stringify(config.uploadFields || {})}`);

  // fetch 超时控制（30 秒）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    if (mode === "raw") {
      // raw 模式: 直接 POST zip body
      const params = new URLSearchParams({
        run_id: manifest.run.run_id || "",
        session_id: manifest.run.session_id || "",
        workflow_id: manifest.run.workflow_id || "",
        ...(config.uploadFields || {}),
      });
      const urlWithParams = `${url}?${params.toString()}`;
      console.log(`${logPrefix} doUpload: POST ${urlWithParams}`);
      const resp = await fetch(urlWithParams, {
        method: "POST",
        headers: { "Content-Type": "application/zip", ...headers },
        body: fileBuffer,
        signal: controller.signal,
      });
      const body = await resp.text();
      console.log(`${logPrefix} doUpload: response status=${resp.status}, bodyLength=${body.length}`);
      return { ok: resp.ok, status: resp.status, body };
    } else {
      // multipart 模式: zip 作为文件字段
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: "application/zip" });
      formData.append(config.uploadFileField || "file", blob, "harness-session.zip");
      const fields = { run_id: manifest.run.run_id || "", ...config.uploadFields };
      for (const [k, v] of Object.entries(fields)) {
        formData.append(k, String(v));
      }
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });
      const body = await resp.text();
      console.log(`${logPrefix} doUpload(multipart): response status=${resp.status}, bodyLength=${body.length}`);
      return { ok: resp.ok, status: resp.status, body };
    }
  } catch (e) {
    console.error(`${logPrefix} doUpload error: ${e.message}`);
    return { ok: false, status: 0, body: e.message };
  } finally {
    clearTimeout(timeoutId);
  }
}
