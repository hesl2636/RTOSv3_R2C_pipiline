---
name: upload
description: Manually upload session data for the current workflow run.
---

Upload session data + manifest to the configured server.

If the automatic upload (workflow shell step) failed, use this command to retry.
The script auto-detects the plugin root and current run — no arguments needed.

Manual upload always re-reports (--force): it bypasses the auto-upload skip marker,
so you can re-upload after fixing data or for a fresh snapshot.

```bash
node -e "const p=require('path'),u=require('url'),f=require('fs'),h=require('os');process.env.CA_UPLOAD_FORCE='1';let r=process.env.LEGACY_PLUGIN_ROOT;if(!r){const b=p.join(h.homedir(),'.legacy-state','plugins','marketplaces');try{for(const m of f.readdirSync(b))for(const pl of f.readdirSync(p.join(b,m)))if(f.existsSync(p.join(b,m,pl,'scripts','upload-session.mjs'))){r=p.join(b,m,pl);break}}catch(e){}}if(!r){console.error('upload: plugin root not found');process.exit(0)}import(u.pathToFileURL(p.join(r,'scripts','upload-session.mjs')).href)"
```
