// evidence-retriever.mjs — 按需召回证据片段给模型
// 核心原则：session 很大不能全量加载，脚本负责低成本召回+精确定位，模型只看召回的少量片段

export class EvidenceRetriever {
  constructor(trace, slices, wiki) {
    this.trace = trace;
    this.slices = slices;
    this.wiki = wiki;
    this.seqToSlice = this._buildSeqMap();
  }

  _buildSeqMap() {
    const map = {};
    for (const slice of this.slices) {
      for (const event of slice.events) {
        map[event.seq] = slice;
      }
    }
    return map;
  }

  // 按候选 scenario 精准召回证据片段
  retrieveForCandidate(candidate, budgetChars = 3500) {
    const primary = this._getPrimarySlices(candidate);
    const supplementary = this._getSupplementarySlices(candidate, primary);
    const all = this._dedupAndSort([...primary, ...supplementary]);
    return this._budgetTruncate(all, budgetChars);
  }

  // 主证据：候选自己的 slice_ids
  _getPrimarySlices(candidate) {
    if (!candidate.slice_ids || candidate.slice_ids.length === 0) return [];
    return candidate.slice_ids
      .map(id => this.slices.find(s => s.slice_id === id))
      .filter(Boolean);
  }

  // 补充证据：按 cluster + keyword 检索
  _getSupplementarySlices(candidate, primary) {
    const primaryIds = new Set(primary.map(s => s.slice_id));
    const supplementary = this.wiki.retrieve(candidate.cluster, null, 8);
    return supplementary.filter(s => !primaryIds.has(s.slice_id)).slice(0, 4);
  }

  // 去重 + 按 seq 排序
  _dedupAndSort(slices) {
    const seen = new Set();
    const unique = slices.filter(s => {
      if (seen.has(s.slice_id)) return false;
      seen.add(s.slice_id);
      return true;
    });
    return unique.sort((a, b) => a.events[0].seq - b.events[0].seq);
  }

  // token 预算截断
  _budgetTruncate(slices, budgetChars) {
    const result = [];
    let usedChars = 0;
    for (const slice of slices) {
      const rendered = this.renderSlice(slice);
      if (usedChars + rendered.length > budgetChars) break;
      result.push({ slice, rendered });
      usedChars += rendered.length;
    }
    return result;
  }

  // 定位 skill 调用前后 N 个 turn
  retrieveAroundSkill(skillName, contextTurns = 2) {
    const skillEvents = this.trace.events.filter(e =>
      e.tool_name === "Skill" &&
      e.tool_input?.skill === skillName
    );

    if (skillEvents.length === 0) {
      // skill 未被调用，返回 skill_listing 注入点
      return this._findSkillListingTurn(skillName);
    }

    const results = [];
    for (const skillEvent of skillEvents) {
      const before = this._getTurnsBefore(skillEvent.seq, contextTurns);
      const after = this._getTurnsAfter(skillEvent.seq, contextTurns);
      const skillSlice = this.seqToSlice[skillEvent.seq];

      results.push({
        type: "skill_invocation",
        skill: skillName,
        skill_event: skillEvent,
        before,
        skill_slice: skillSlice,
        after,
      });
    }
    return results;
  }

  // 定位 skill_listing 注入点
  _findSkillListingTurn(skillName) {
    const attachmentEvents = this.trace.events.filter(e =>
      e.type === "attachment" &&
      e.tool_name === "skill_listing" &&
      e.tool_output?.includes(skillName)
    );

    return attachmentEvents.map(attachmentEvent => {
      const slice = this.seqToSlice[attachmentEvent.seq];
      return {
        type: "skill_listing",
        skill: skillName,
        attachment_event: attachmentEvent,
        slice,
      };
    });
  }

  // 按 seq 获取前 N 个 turn
  _getTurnsBefore(seq, n) {
    const targetSlice = this.seqToSlice[seq];
    if (!targetSlice) return [];

    const targetIdx = this.slices.findIndex(s => s.slice_id === targetSlice.slice_id);
    const startIdx = Math.max(0, targetIdx - n);
    return this.slices.slice(startIdx, targetIdx);
  }

  // 按 seq 获取后 N 个 turn
  _getTurnsAfter(seq, n) {
    const targetSlice = this.seqToSlice[seq];
    if (!targetSlice) return [];

    const targetIdx = this.slices.findIndex(s => s.slice_id === targetSlice.slice_id);
    const endIdx = Math.min(this.slices.length, targetIdx + n + 1);
    return this.slices.slice(targetIdx + 1, endIdx);
  }

  // AI Native: 根据模型请求获取更多后续片段
  retrieveMoreSlices(requestedSliceIds, budgetChars = 3500) {
    const slices = requestedSliceIds
      .map(id => this.slices.find(s => s.slice_id === id))
      .filter(Boolean);
    return this._budgetTruncate(slices, budgetChars);
  }

  // AI Native: 获取指定切片的前后上下文
  retrieveContextAround(sliceId, beforeTurns = 2, afterTurns = 2, budgetChars = 3500) {
    const targetSlice = this.slices.find(s => s.slice_id === sliceId);
    if (!targetSlice) return [];

    const targetIdx = this.slices.findIndex(s => s.slice_id === sliceId);
    const startIdx = Math.max(0, targetIdx - beforeTurns);
    const endIdx = Math.min(this.slices.length, targetIdx + afterTurns + 1);
    const contextSlices = this.slices.slice(startIdx, endIdx);

    return this._budgetTruncate(contextSlices, budgetChars);
  }

  // 紧凑渲染（给模型看的格式）
  renderSlice(slice) {
    const lines = [];
    lines.push(`### slice ${slice.slice_id} [${slice.workflow_stage}]`);

    for (const event of slice.events) {
      if (event.type === "tool_call") {
        const cmd = event.tool_input?.command || JSON.stringify(event.tool_input).slice(0, 120);
        lines.push(`[${event.seq}] ${event.tool_name}: ${cmd}`);

        if (event.tool_output) {
          const output = event.tool_output;
          if (event.is_error || output.length <= 400) {
            lines.push(`     -> ${event.is_error ? "ERR " : ""}${output.slice(0, 400)}`);
          } else {
            lines.push(`     -> (${output.length} chars, truncated) ${output.slice(0, 120)}`);
          }
        }
      } else if (event.type === "user" && event.text) {
        lines.push(`[${event.seq}] USER: ${event.text.slice(0, 160)}`);
      }
    }

    return lines.join("\n");
  }

  // 渲染 skill 调用上下文
  renderSkillContext(skillContext) {
    const lines = [];

    if (skillContext.type === "skill_invocation") {
      lines.push(`### Skill: ${skillContext.skill} (调用)`);
      lines.push("#### 调用前上下文");
      for (const slice of skillContext.before) {
        lines.push(this.renderSlice(slice));
      }
      lines.push("#### Skill 调用");
      lines.push(this.renderSlice(skillContext.skill_slice));
      lines.push("#### 调用后上下文");
      for (const slice of skillContext.after) {
        lines.push(this.renderSlice(slice));
      }
    } else if (skillContext.type === "skill_listing") {
      lines.push(`### Skill: ${skillContext.skill} (加载但未调用)`);
      lines.push("#### skill_listing 注入点");
      lines.push(this.renderSlice(skillContext.slice));
    }

    return lines.join("\n\n");
  }

  // 组装证据包（给模型看）
  assembleEvidencevidencePacket(evidenceItems, maxChars = 3500) {
    const rendered = evidenceItems.map(item => {
      if (item.type === "skill_context") {
        return this.renderSkillContext(item.context);
      } else if (item.slice) {
        return this.renderSlice(item.slice);
      }
      return "";
    }).filter(Boolean);

    const packet = rendered.join("\n\n---\n\n");

    if (packet.length > maxChars) {
      return packet.slice(0, maxChars) + "\n\n[truncated]";
    }
    return packet;
  }

  // AI Native: 获取指定切片之后的 N 个片段
  getNextFragments(sliceId, count = 2) {
    const slice = this.slices.find(s => s.slice_id === sliceId);
    if (!slice) return [];

    const sliceIdx = this.slices.findIndex(s => s.slice_id === sliceId);
    const startIdx = sliceIdx + 1;
    const endIdx = Math.min(this.slices.length, startIdx + count);

    return this.slices.slice(startIdx, endIdx).map(s => ({
      slice_id: s.slice_id,
      rendered: this.renderSlice(s),
      workflow_stage: s.workflow_stage,
      call_type: s.call_type
    }));
  }

  // AI Native: 获取指定切片之前的 N 个片段
  getPreviousFragments(sliceId, count = 2) {
    const slice = this.slices.find(s => s.slice_id === sliceId);
    if (!slice) return [];

    const sliceIdx = this.slices.findIndex(s => s.slice_id === sliceId);
    const endIdx = sliceIdx;
    const startIdx = Math.max(0, endIdx - count);

    return this.slices.slice(startIdx, endIdx).map(s => ({
      slice_id: s.slice_id,
      rendered: this.renderSlice(s),
      workflow_stage: s.workflow_stage,
      call_type: s.call_type
    }));
  }

  // AI Native: 根据 slice_id 获取指定片段
  getFragmentById(sliceId) {
    const slice = this.slices.find(s => s.slice_id === sliceId);
    if (!slice) return null;

    return {
      slice_id: slice.slice_id,
      rendered: this.renderSlice(slice),
      workflow_stage: slice.workflow_stage,
      call_type: slice.call_type
    };
  }

  // AI Native: 获取 session 的总片段数和当前片段索引
  getSessionOverview() {
    return {
      total_fragments: this.slices.length,
      fragments: this.slices.map((s, idx) => ({
        index: idx,
        slice_id: s.slice_id,
        workflow_stage: s.workflow_stage,
        call_type: s.call_type,
        event_count: s.events.length
      }))
    };
  }
}
