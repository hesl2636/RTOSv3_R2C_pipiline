---
description: r2c workflow role ${AGENT_ROLE} (subagent)
mode: subagent
---

# ${AGENT_ROLE}

This subagent is derived by the r2c adapter from the workflow manifest.

- Only `r2c submit` advances run state; never edit `.r2c/` by hand.
- The main session owns the Submit command; follow the step prompt delivered
  by the r2c plugin.
- Use the installed `r2c-*` commands and skills for the current step.
