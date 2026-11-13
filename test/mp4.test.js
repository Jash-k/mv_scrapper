import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMp4, verifyMp4, verifyAll } from '../src/moviesda/verify.js';
import { resolveServerLink, getDownloadSelectionUrls } from '../src/moviesda/extractor.js';
import { buildOutputs } from '../src/moviesda/build.js';

const mp4 = Buffer.alloc(100);
mp4.writeUInt32BE(24); mp4.write('ftyp',4); mp4.write('isom',8); mp4.write('isom',16); mp4.write('mp42',20);

test('MP4 signature rejects TS, images, truncation, fake ftyp', () => {
  assert.ok(isMp4(mp4));
  const image=Buffer.from(mp4); image.write('avif',8); image.write('avif',16); image.write('avif',20);
  assert.equal(isMp4(image),false);
  const ts=Buffer.alloc(400); ts[0]=ts[188]=0x47;
  assert.equal(isMp4(ts),false);
  assert.equal(isMp4(mp4.subarray(0,12)),false);
  const fake=Buffer.from(mp4); fake.writeUInt32BE(0);
  assert.equal(isMp4(fake),false);
});

test('HTTP verification, redirects, gates, retries, extraction', async () => {
  let retry=0;
  const server=http.createServer((req,res) => {
    if(req.url==='/retry' && retry++===0) { res.writeHead(503).end(); return; }
    if(req.url==='/redirect') { res.writeHead(302,{Location:'/relative'}).end(); return; }
    if(req.url==='/relative') { res.writeHead(307,{Location:'/video.mp4'}).end(); return; }
    if(req.url==='/loop') { res.writeHead(302,{Location:'/loop'}).end(); return; }
    if(req.url==='/meta') { res.end('<meta http-equiv="refresh" content="0; url=/video.mp4">'); return; }
    if(req.url==='/listing') { res.end('<a href="/download/1">one</a><a href="download/2">two</a>'); return; }
    if(req.url==='/gate.mp4') { res.writeHead(200,{'Content-Type':'text/html'}).end('<html>gate</html>'); return; }
    if(req.url==='/missing') { res.writeHead(404).end(); return; }
    if(req.url==='/wrong-range') { res.writeHead(206,{'Content-Range':'bytes 5-104/1000'}).end(mp4); return; }
    if(req.url==='/no-range') { res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':mp4.length}).end(mp4); return; }
    assert.equal(req.headers.referer,undefined);
    res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 0-99/1500000000'}).end(mp4);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const result=await verifyMp4(base+'/redirect');
    assert.equal(result.ok,true); assert.equal(result.url,base+'/video.mp4'); assert.equal(result.size_bytes,1500000000);
    assert.equal((await verifyMp4(base+'/gate.mp4')).ok,false);
    assert.equal((await verifyMp4(base+'/wrong-range')).ok,false);
    assert.equal((await verifyMp4(base+'/missing')).status,404);
    assert.equal((await verifyMp4(base+'/no-range')).ok,true);
    assert.equal((await verifyMp4(base+'/retry')).ok,true); assert.equal(retry,2);
    assert.equal((await resolveServerLink(base+'/redirect')).url,base+'/video.mp4');
    assert.equal((await resolveServerLink(base+'/meta')).url,base+'/video.mp4');
    assert.equal(await resolveServerLink(base+'/loop'),null);
    assert.deepEqual(await getDownloadSelectionUrls(base+'/listing'),[base+'/download/1',base+'/download/2']);
  } finally { await new Promise(r=>server.close(r)); }
});

test('verification isolates checker failures and enforces concurrency input',async()=>{
  const result=await verifyAll([{url:'a'},{url:'b'}], async u=>{if(u==='a')throw Error();return {ok:true};});
  assert.equal(result[0].ok,false); assert.equal(result[1].ok,true);
  await assert.rejects(verifyAll([],()=>{}, {concurrency:0}));
});

test('direct-only outputs work without TMDB; preserve distinct CDN paths and magnet feed',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mp4-test-'));
  const urls=['https://cdn.example/a/file.mp4','https://cdn.example/b/file.mp4'];
  const source=JSON.stringify([{titleGuess:'Owned demo',qualities:[{type:'magnet',url:'magnet:?xt=urn:btih:abc'}]}]);
  try {
    await mkdir(path.join(root,'data')); await writeFile(path.join(root,'data/movies.json'),source);
    const good=new Map(urls.map(url=>[url,{ok:true,url,size_bytes:1500000000,verifiedAt:'2026-11-13T00:00:00Z'}]));
    const stats=await buildOutputs([{title:'Owned demo',year:2026,mp4s:[...urls.map(url=>({url,type:'mp4',quality:'1080p'})),{url:'https://bad.example/x',type:'mp4',quality:'720p'}]}],{mp4Verify:good,root});
    assert.equal(stats.mp4Streams,2); assert.equal(stats.stremioCatalog,1); assert.equal(stats.stremioStreamFiles,1);
    const catalog=JSON.parse(await readFile(path.join(root,'stremio/catalog/movie/moviesda-tamil.json')));
    const id=catalog.metas[0].id;
    const stream=JSON.parse(await readFile(path.join(root,`stremio/stream/movie/${id}.json`)));
    assert.equal(stream.streams.length,2); assert.ok(stream.streams.every(s=>s.url && !s.infoHash));
    assert.equal(await readFile(path.join(root,'data/movies.json'),'utf8'),source);
    assert.equal(JSON.parse(await readFile(path.join(root,'data/moviesda.json')))[0].qualities[0].size_bytes,1500000000);
    await buildOutputs([],{mp4Verify:new Map(),root});
    await assert.rejects(readFile(path.join(root,`stremio/stream/movie/${id}.json`)));
  } finally { await rm(root,{recursive:true,force:true}); }
});
