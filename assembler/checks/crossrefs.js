/**
 * Cross-reference checks (decision #67 §7.9).
 *
 * Errors compare step references against the *declared* sets (file existence
 * is reported once by the per-kind modules). Unused warnings only run when the
 * stage set is complete (S8): a missing stage would otherwise claim that every
 * later asset is unused.
 */
export function check(context) {
  if (context.skipped.crossrefs) return;
  if (context.stages === null) return;

  const declared = context.declared;
  const usedTasks = new Set();
  const usedRoles = new Set();
  const usedSkills = new Set();
  const skillDeclared = context.declaredValid.skills !== false;
  const taskDeclared = context.declaredValid.tasks !== false;
  const roleDeclared = context.declaredValid.roles !== false;

  for (const stage of context.stages) {
    for (const step of stage.steps) {
      if (typeof step.task === 'string') {
        usedTasks.add(step.task);
        if (taskDeclared && !declared.tasks.includes(step.task)) {
          context.fail(stage.path, 'BUNDLE_STEP_TASK_UNDECLARED', `step references an undeclared task: ${step.task}`, {
            pointer: `${step.pointer}/task`,
            details: { pointer: `${step.pointer}/task`, field: 'task', id: step.task },
          });
        }
      }
      if (typeof step.role === 'string') {
        usedRoles.add(step.role);
        if (roleDeclared && !declared.roles.includes(step.role)) {
          context.fail(stage.path, 'BUNDLE_STEP_ROLE_UNDECLARED', `step references an undeclared role: ${step.role}`, {
            pointer: `${step.pointer}/role`,
            details: { pointer: `${step.pointer}/role`, field: 'role', id: step.role },
          });
        }
      }
      step.skills.forEach((skill, index) => {
        if (typeof skill !== 'string') return;
        usedSkills.add(skill);
        if (skillDeclared && !declared.skills.includes(skill)) {
          context.fail(stage.path, 'BUNDLE_STEP_SKILL_UNDECLARED', `step references an undeclared skill: ${skill}`, {
            pointer: `${step.pointer}/skills/${index}`,
            details: { pointer: `${step.pointer}/skills/${index}`, field: 'skills', id: skill },
          });
        }
      });
      if (step.skills.length === 0 && declared.skills.length > 0) {
        context.warn(stage.path, 'BUNDLE_STEP_NO_SKILLS', 'step enables no skills', {
          pointer: `${step.pointer}/skills`,
          details: { step: step.id },
        });
      }
    }
  }

  if (context.roles instanceof Map) {
    for (const role of context.roles.values()) {
      const preloaded = role.fields?.skills;
      if (Array.isArray(preloaded)) for (const skill of preloaded) usedSkills.add(skill);
    }
  }

  if (!context.complete.stages) return;

  if (taskDeclared) {
    for (const id of declared.tasks) {
      if (!usedTasks.has(id)) {
        context.warn(`tasks/${id}.md`, 'BUNDLE_TASK_UNUSED', 'declared task is not referenced by any step', {
          details: { id },
        });
      }
    }
  }
  if (roleDeclared) {
    for (const id of declared.roles) {
      if (!usedRoles.has(id)) {
        context.warn(`roles/${id}.md`, 'BUNDLE_ROLE_UNUSED', 'declared role is not referenced by any step', {
          details: { id },
        });
      }
    }
  }
  if (skillDeclared) {
    for (const id of declared.skills) {
      if (!usedSkills.has(id)) {
        context.warn(`skills/${id}/SKILL.md`, 'BUNDLE_SKILL_UNUSED', 'declared skill is neither enabled nor preloaded', {
          details: { id },
        });
      }
    }
  }
}
