'use strict';
const {fault} = require('./protocol.cjs');
const ROOT = '/luna/pc/';
const KINDS = {tracks:'track',albums:'album',artists:'artist',playlists:'playlist'};
function pagination() { const e = new Error('汽水分页数据不完整或超过读取上限。'); e.code = 'pagination'; return e; }
function id(value) { if (typeof value !== 'string' || !/^[\w-]{1,128}$/.test(value)) throw fault('protocol'); return value; }
function offset(value=0) { if (!Number.isSafeInteger(value) || value<0) throw fault('protocol'); return value; }
function list(value) { if (!Array.isArray(value) || value.length>5000) throw fault('response'); return value; }
function entity(raw,kind) { const v=raw?.entity?.[kind] ?? raw?.[kind] ?? raw; if (!v || typeof v!=='object' || Array.isArray(v) || typeof v.id!=='string' || !/^[\w-]{1,128}$/.test(v.id)) throw fault('response'); return v; }
function text(v) { return typeof v==='string' ? v.slice(0,4096) : ''; }
function image(v) {
 // Absolute string covers are returned as-is. Object CDN descriptors need uri + transform.
 if(typeof v==='string')return /^https?:\/\//.test(v)?v.slice(0,4096):undefined;
 if(!v||typeof v!=='object'||Array.isArray(v))return undefined;
 let url=Array.isArray(v.urls)?v.urls.find(x=>typeof x==='string' && /^https?:\/\//.test(x)):undefined;
 if(typeof url!=='string')return undefined;
 if(typeof v.uri==='string' && v.uri && v.uri.length<=512 && !url.includes(v.uri))url+=v.uri;
 if(!url.includes('~')){
  // Live CDN rejects bare base+uri (HTTP 400). Scene PNGs need template_prefix resize;
  // tracks also accept ~c5_400x400.jpg when no prefix is supplied.
  const prefix=typeof v.template_prefix==='string' && /^[A-Za-z0-9._-]{1,64}$/.test(v.template_prefix)?v.template_prefix:null;
  url+=prefix?`~${prefix}-resize:400:400.webp`:'~c5_400x400.jpg';
 }
 return url.slice(0,4096);
}
function mapArtist(raw) { const v=entity(raw,'artist');return {id:v.id,name:text(v.name),imageUrl:image(v.url_cover??v.medium_avatar_url)}; }
function mapAlbum(raw) { const v=entity(raw,'album');return {id:v.id,name:text(v.name),imageUrl:image(v.url_cover),artists:v.artists===undefined?[]:list(v.artists).map(mapArtist)}; }
function mapTrack(raw) {
 if(raw?.type && raw.type!=='track')throw fault('response');
 const container=raw?.entity??raw;
 const wrapper=container?.track_wrapper?.track;
 const v=wrapper??entity(raw,'track');
 const base=v.base_info??v;
 entity(base,'track');
 const duration=base.duration_ms??base.duration??0;
 if (!Number.isSafeInteger(duration)||duration<0) throw fault('response');
 const albumRaw=v.related_info?.album_link??v.album;
 const album=albumRaw?mapAlbum(albumRaw):{id:'',name:''};
 if (!album.imageUrl) album.imageUrl=image(v.display_info?.cover_url??v.display_info?.url_cover??v.url_cover);
 const artists=v.related_info?.artist_links??v.artists;
 const mappedArtists=artists===undefined?[]:list(artists).map(a=>{try{return mapArtist(a);}catch{return a&&typeof a==='object'?{id:typeof a.id==='string'?a.id:'',name:text(a.name||a.nickname||'')}:null;}}).filter(Boolean);
 return {id:base.id,name:text(base.name),artists:mappedArtists,album,duration};
}
function mapPlaylist(raw,accountId) { const v=entity(raw,'playlist');return {id:v.id,name:text(v.title||v.public_title||v.name),imageUrl:image(v.url_cover),description:text(v.description),owner:text(v.owner?.nickname),trackCount:Number.isSafeInteger(v.count_tracks)&&v.count_tracks>=0?v.count_tracks:0,mine:!!accountId&&v.owner?.id===accountId}; }
const MAPPERS={tracks:mapTrack,albums:mapAlbum,artists:mapArtist,playlists:mapPlaylist};
function unique(items) { return [...new Map(items.map(x=>[x.id,x])).values()]; }
function terminal(root) {
 if(root.has_more!==undefined && typeof root.has_more!=='boolean') throw fault('response');
 return root.has_more!==true;
}
function successful(root) {
 const status=root.status_info;
 return !!status && typeof status==='object' && !Array.isArray(status) && status.status_code===0;
}
function pageList(root,field,emptyContext) {
 const done=terminal(root);
 const key=Array.isArray(field)?field.find(k=>Object.hasOwn(root,k)):field;
 if((key===undefined || !Object.hasOwn(root,key)) && done && emptyContext())return [];
 return list(root[key]);
}
function nextPage(root,count,cursors) {
 const done=terminal(root);
 if(root.has_more!==false && root.total_num!==undefined && (!Number.isSafeInteger(root.total_num)||root.total_num<0))throw fault('response');
 if(done) return null;
 if(!count || typeof root.next_cursor!=='string'||!root.next_cursor||root.next_cursor.length>4096||cursors.has(root.next_cursor)) throw pagination();
 return root.next_cursor;
}

class Catalog {
 constructor({api,account,now=Date.now}={}) {
  if(typeof api!=='function'||typeof account!=='function'||typeof now!=='function') throw fault('protocol');
  this.api=api;this.account=account;this.now=now;this.generation=0;this.queue=Promise.resolve();this.clear();
 }
 _reset() { this.accountId=null;this.searches=new Map();this.feeds=new Map();this.modes=null;this.likes=null;this.stationCovers=new Map(); }
 clear() { this.generation++;this._reset(); }
 invalidate(scope) { if(scope!==undefined && (typeof scope!=='string'||scope.length>128)) throw fault('protocol');this.clear(); }
 async _run(fn) {
  // Capture at submission so resets also cancel operations still in the queue.
  const generation=this.generation;
  const operation=this.queue.then(async()=>{
   if(generation!==this.generation)throw fault('account');
   const a=await this.account();
   if(generation!==this.generation)throw fault('account');
   if(!a) {this.clear();throw fault('account');}id(a.id);
   // Serialized account changes reset caches without cancelling subsequent reads.
   if(this.accountId!==a.id){this._reset();this.accountId=a.id;}
   const ctx={generation:this.generation,start:this.now()};return fn(ctx);
  });this.queue=operation.catch(()=>{});return operation;
 }
 _check(ctx) { if(ctx.generation!==this.generation) throw fault('account');if(this.now()-ctx.start>=25000) throw pagination(); }
 async _api(ctx,path,query={},body) {
  this._check(ctx);let timer;
  try { const result=await Promise.race([this.api(ROOT+path,query,body),new Promise((_,reject)=>{timer=setTimeout(()=>reject(pagination()),Math.max(1,25000-(this.now()-ctx.start)));})]);
   this._check(ctx);if(!result||typeof result!=='object'||Array.isArray(result)) throw fault('response');return result;
  } finally {clearTimeout(timer);}
 }
 async _all(ctx,path,field,query={},mapper=x=>x,maxPages=50) {
  let cursor='';const cursors=new Set(['']);const out=[];let root;let rawCount=0;
  for(let page=0;page<maxPages;page++){
   root=await this._api(ctx,path,{...query,cursor,count:100});const raw=pageList(root,field,()=>{
    if(path==='playlist/detail'){const meta=root.playlist??root.playlist_info;return !!meta && mapPlaylist(meta,this.accountId).id===query.playlist_id;}
    return successful(root);
   });rawCount+=raw.length;if(rawCount>5000)throw pagination();const filtered=path==="playlist/detail"?raw.filter(x=>!x?.type||x.type==="track"):raw;out.push(...filtered.map(mapper));
   const next=nextPage(root,raw.length,cursors);if(next===null)return {items:out,root};if(rawCount>=5000)throw pagination();cursors.add(next);cursor=next;
  }throw pagination();
 }
 search({query,kind='tracks',offset:at=0}={}) {
  return this._run(async ctx=>{
   offset(at);if(typeof query!=='string'||!query.trim()||query.length>512||!Object.hasOwn(KINDS,kind))throw fault('protocol');
   const key=JSON.stringify([query,kind]);let s=this.searches.get(key);
   if(!s){s={items:[],cursor:'',cursors:new Set(['']),done:false};this.searches.set(key,s);while(this.searches.size>16)this.searches.delete(this.searches.keys().next().value);}
   for(let n=0;n<8;n++){
    if(at<s.items.length||s.done) return {[kind]:s.items.slice(at,at+20),more:at+20<s.items.length||!s.done};
    const root=await this._api(ctx,'search/'+KINDS[kind],{q:query,cursor:s.cursor,search_method:'input'});
    const g=list(root.result_groups).find(x=>x.id===kind);if(!g)throw fault('response');const raw=pageList(g,'data',()=>successful(root));const mapped=unique(raw.map(x=>MAPPERS[kind](x,this.accountId)));
    const fresh=mapped.filter(x=>!s.items.some(y=>y.id===x.id));const next=nextPage(g,raw.length,s.cursors);
    if(next!==null&&!fresh.length)throw pagination();if(s.items.length+fresh.length>5000)throw pagination();
    s.items.push(...fresh);s.done=next===null;if(next!==null){s.cursor=next;s.cursors.add(next);}
   }
   if(at<s.items.length||s.done)return {[kind]:s.items.slice(at,at+20),more:at+20<s.items.length||!s.done};throw pagination();
  });
 }
 async _own(ctx) {return (await this._all(ctx,'user/playlist','playlists',{user_id:this.accountId})).items;}
 async _mixed(ctx) {return (await this._all(ctx,'me/collection/mixed','mixed_collections')).items;}
 async _playlists(ctx) {
  const own=await this._own(ctx), mixed=await this._mixed(ctx);const result=new Map();
  for(const item of mixed)if(item.item_type==='playlist'){const p=mapPlaylist(item.playlist,this.accountId);p.saved=true;result.set(p.id,p);}
  for(const item of own){const p=mapPlaylist(item,this.accountId);if(p.mine||!result.has(p.id))result.set(p.id,p);}return [...result.values()];
 }
 playlists() {return this._run(ctx=>this._playlists(ctx));}
 async _playlist(ctx,value) {
  const {items,root}=await this._all(ctx,'playlist/detail',['media_resources','media'],{playlist_id:value},mapTrack);
  const meta=root.playlist??root.playlist_info;if(!meta)throw fault('response');const p=mapPlaylist(meta,this.accountId);if(p.id!==value)throw fault('response');return {...p,tracks:unique(items.filter(Boolean))};
 }
 playlist({id:value}={}) {return this._run(ctx=>this._playlist(ctx,id(value)));}
 async _likes(ctx) {
  if(this.likes&&this.now()-this.likes.time<30000)return this.likes.tracks;
  const own=await this._own(ctx);const candidates=own.filter(p=>p.owner?.id===this.accountId);
  const p=candidates.find(x=>x.type===1)??candidates.find(x=>/^(我喜欢|Liked)$/i.test(x.title||x.public_title||''));
  if(!p)throw pagination();const tracks=(await this._playlist(ctx,id(p.id))).tracks;this.likes={time:this.now(),tracks};return tracks;
 }
 liked({offset:at=0}={}) {return this._run(async ctx=>{offset(at);const tracks=await this._likes(ctx);return {tracks:tracks.slice(at,at+100),more:at+100<tracks.length};});}
 isLiked({ids}={}) {return this._run(async ctx=>{if(!Array.isArray(ids)||ids.length>500)throw fault('protocol');ids.forEach(id);const set=new Set((await this._likes(ctx)).map(x=>x.id));return Object.fromEntries(ids.map(x=>[x,set.has(x)]));});}
 savedAlbums({offset:at=0}={}) {return this._run(async ctx=>{offset(at);const albums=unique((await this._mixed(ctx)).filter(x=>x.item_type==='album').map(x=>({...mapAlbum(x.album),saved:true})));return {albums:albums.slice(at,at+100),more:at+100<albums.length};});}
 async _recent(ctx) {return unique((await this._all(ctx,'me/recently-played-media','media',{media_type:'track',scene:''},mapTrack)).items);}
 recent() {return this._run(ctx=>this._recent(ctx));}
 async _stations(ctx) {
  const root=await this._api(ctx,'feed/mode',{},{});const modes=list(root.feed_mode_block).flatMap(x=>list(x.feed_mode));modes.push(...list(root.feed_mode_bar?.feed_mode));
  const result=[{id:'default',name:'推荐'},{id:'familiar',name:'熟悉'},{id:'fresh',name:'新鲜'}];
  for(const mode of modes){const v=mode.entity?.feed_scene_mode?.scene_mode_id;if(Number.isSafeInteger(v)&&v>0)result.push({id:'scene:'+v,name:text(mode.text),imageUrl:image(mode.url_info)});}
  this.modes=new Set(result.map(x=>x.id));return unique(result);
 }
 // One-shot cover probe: does not advance the playback feed session.
 async _peekCover(ctx,value) {
  const body={is_first_request:true,played_media:[],is_did_first_request:false,feed_counts:{mix_session_count:1}};
  if(value==='familiar'||value==='fresh')body.feed_preference={preference_mode:value};
  else if(value.startsWith('scene:'))body.feed_preference={scene_mode_id:Number(value.slice(6))};
  const root=await this._api(ctx,'feed/song-tab',{},body);
  const raw=list(Object.hasOwn(root,'media')?root.media:root.items);
  for(const row of raw){
   try{const cover=mapTrack(row).album?.imageUrl;if(cover)return cover;}catch{/* skip malformed rows */}
  }
  return undefined;
 }
 async _enrichStationCovers(ctx,stations) {
  const need=stations.filter(s=>!this.stationCovers.has(s.id));
  for(let i=0;i<need.length;i+=6){
   this._check(ctx);
   const batch=need.slice(i,i+6);
   const found=await Promise.all(batch.map(async s=>{
    try{return [s.id,await this._peekCover(ctx,s.id)];}catch{return [s.id,undefined];}
   }));
   for(const [id,cover] of found)if(cover)this.stationCovers.set(id,cover);
  }
  return stations.map(s=>{const cover=this.stationCovers.get(s.id);return cover?{...s,imageUrl:cover}:s;});
 }
 stations() {return this._run(async ctx=>this._enrichStationCovers(ctx,await this._stations(ctx)));}
 async _feed(ctx,value) {
  if(!['default','familiar','fresh'].includes(value)) {if(!/^scene:[1-9]\d{0,14}$/.test(value))throw fault('protocol');if(!this.modes)await this._stations(ctx);if(!this.modes.has(value))throw fault('protocol');}
  let s=this.feeds.get(value);if(!s){s={pages:0,played:[],seen:new Set(),done:false};this.feeds.set(value,s);while(this.feeds.size>16)this.feeds.delete(this.feeds.keys().next().value);}
  const tracks=[];
  for(let n=0;n<2&&!s.done&&!tracks.length;n++){
   const body={is_first_request:s.pages===0,played_media:s.played.slice(-30),is_did_first_request:false,feed_counts:{mix_session_count:1}};
   if(value==='familiar'||value==='fresh')body.feed_preference={preference_mode:value};else if(value.startsWith('scene:'))body.feed_preference={scene_mode_id:Number(value.slice(6))};
   const root=await this._api(ctx,'feed/song-tab',{},body);const raw=list(Object.hasOwn(root,'media')?root.media:root.items);if(root.has_more!==undefined&&typeof root.has_more!=='boolean')throw fault('response');
   const mapped=unique(raw.map(mapTrack));s.pages++;
   if(!raw.length&&root.has_more===true)throw pagination();
   s.done=root.has_more===false||raw.length===0;
   for(const t of mapped)if(!s.seen.has(t.id)){tracks.push(t);s.seen.add(t.id);s.played.push({id:t.id,type:'track'});while(s.seen.size>1000)s.seen.delete(s.seen.values().next().value);}
   s.played=s.played.slice(-30);
  }return {tracks,more:!s.done};
 }
 stationNext({id:value}={}) {return this._run(async ctx=>{if(typeof value!=='string')throw fault('protocol');return (await this._feed(ctx,value)).tracks;});}
 async _discover(ctx,charts) {
  // The new-discovery flag suppresses chart blocks; both routes need the mixed response.
  const root=await this._api(ctx,'discover',{},{});const sections=[];let visited=0;
  for(const block of list(root.blocks))for(const inner of list(block.inner_block)){
   this._check(ctx);if(++visited>5000)throw pagination();
   const section={title:text(inner.title||block.title),tracks:[],albums:[],artists:[],playlists:[]};
   for(const resource of list(inner.resources)){if(++visited>5000)throw pagination();const e=resource.entity??resource;
    if(e.ranked_track?.track)section.tracks.push(mapTrack(e.ranked_track.track));
    else if(!charts)for(const [plural,singular]of Object.entries(KINDS))if(e[singular])section[plural].push(MAPPERS[plural](e[singular],this.accountId));
   }if(Object.keys(KINDS).some(k=>section[k].length))sections.push(section);
  }return {title:charts?'榜单':'发现',sections};
 }
 async _home(ctx) {
  // MyGo renders the first tracks section as the daily feature card; later sections
  // fill the page. Feed-only homes look empty, so compose discover/stations too.
  const feed=await this._feed(ctx,'default');
  const sections=[{title:'每日推荐',tracks:feed.tracks,...(feed.more?{morePage:'feed:default'}:{})}];
  try{
   const stations=await this._enrichStationCovers(ctx,await this._stations(ctx));
   const featured=stations.filter(s=>s.imageUrl).slice(0,12);
   if(featured.length)sections.push({title:'情景电台',stations:featured});
  }catch(error){if(error?.code==='account'||error?.code==='pagination')throw error;}
  try{
   const discover=await this._discover(ctx,false);
   const playlists=unique(discover.sections.flatMap(s=>s.playlists||[])).slice(0,20);
   if(playlists.length)sections.push({title:'精选歌单',playlists,morePage:'discover'});
   const charts=unique(discover.sections.flatMap(s=>s.tracks||[])).slice(0,20);
   if(charts.length)sections.push({title:'热歌榜',tracks:charts,morePage:'charts'});
   const imageUrl=playlists[0]?.imageUrl||feed.tracks[0]?.album?.imageUrl;
   sections.push({title:'探索',links:[
    {title:'发现',subtitle:'更多精选内容',page:'discover',...(imageUrl?{imageUrl}:{})},
    {title:'榜单',subtitle:'热门歌曲',page:'charts'},
    {title:'最近播放',subtitle:'继续听',page:'history'},
   ]});
  }catch(error){if(error?.code==='account'||error?.code==='pagination')throw error;}
  return {title:'首页',sections};
 }
 async _browse(ctx,page) {
  if(page==='discover'||page==='charts')return this._discover(ctx,page==='charts');
  if(page==='history')return {title:'最近播放',sections:[{tracks:await this._recent(ctx)}]};
  if(page==='library')return {title:'我的歌单',sections:[{playlists:await this._playlists(ctx)}]};
  if(page==='home')return this._home(ctx);
  if(page==='feed:default'){const p=await this._feed(ctx,'default');return {title:'推荐',sections:[{tracks:p.tracks,...(p.more?{morePage:'feed:default'}:{})}]};}
  throw fault('protocol');
 }
 home() {return this._run(ctx=>this._browse(ctx,'home'));}
 browse({page}={}) {return this._run(ctx=>this._browse(ctx,page));}
}
module.exports={Catalog,mapTrack,mapAlbum,mapArtist,mapPlaylist};
