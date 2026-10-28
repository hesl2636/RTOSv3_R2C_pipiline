---
name: analysis
description: Manually run attribution analysis for the current workflow run.
---

Run attribution analysis (sdoc-js) for the current workflow run and upload the report.

If the automatic analysis (workflow shell step) failed or was skipped, use this command to retry.
The script auto-detects the plugin root and current run — no arguments needed.

```bash
node -e "const p=require('path'),u=require('url'),f=require('fs'),h=require('os');let r=process.env.CODEAGENT3_PLUGIN_ROOT;if(!r){const b=p.join(h.homedir(),'.cac','plugins','marketplaces');try{for(const m of f.readdirSync(b))for(const pl of f.readdirSync(p.join(b,m)))if(f.existsSync(p.join(b,m,pl,'scripts','analyze-session.mjs'))){r=p.join(b,m,pl);break}}catch(e){}}if(!r){console.error('analysis: plugin root not found');process.exit(0)}import(u.pathToFileURL(p.join(r,'scripts','analyze-session.mjs')).href)"
```
