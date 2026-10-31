#!/usr/bin/env node
import {build} from 'esbuild';
import {loadEnv} from 'vite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(tmpdir(),'podcut-episode-'));
try{const file=path.join(temp,'run.mjs');await build({entryPoints:[path.join(root,'agent-tools/episode.ts')],outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'});const {run}=await import(pathToFileURL(file));await run(process.argv.slice(2),root,{...process.env,...loadEnv('development',root,'')});}
catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}
finally{await rm(temp,{recursive:true,force:true});}
