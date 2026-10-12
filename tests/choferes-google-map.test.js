import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(){
  const file='pedidos/inicio/choferes-google-map.js';
  assert.ok(fs.existsSync(file),'Dedicated Google tracking renderer must exist');
  const nodes=new Map();const node=()=>({style:{},textContent:'',hidden:true,checked:false});const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const markers=[];const lines=[];
  class MapDouble{constructor(_el,options){this.center=options.center;this.zoom=options.zoom;this.fits=0;}fitBounds(){this.fits++;}getCenter(){return this.center;}setCenter(p){this.center=p;}getZoom(){return this.zoom;}setZoom(z){this.zoom=z;}}
  class Marker{constructor(options){Object.assign(this,options);markers.push(this);}addListener(_event,callback){this.click=callback;}}
  class Polyline{constructor(options){Object.assign(this,options);lines.push(this);}setMap(map){this.map=map;}}
  class InfoWindow{setContent(content){this.content=content;}open(options){this.options=options;}close(){}}
  const context=vm.createContext({console,setTimeout,clearTimeout,URLSearchParams,STATE:{isSuper:false,user:{empresa_id:7}},trackingMap:null,trackingMarkersLayer:null,trackingTrailLayer:null,trackingTrails:new Map(),trackingMarkerByPedido:new Map(),$:selector=>get(selector.slice(1)),esc:s=>String(s||'').replaceAll('<','&lt;'),fmtAgo:()=> 'hace 1 minuto',isStale:()=>false,buildAlert:item=>({text:item.alert?'Alerta':'Normal'}),authFetch:async()=>({ok:true,status:200,json:async()=>({apiKey:'synthetic-browser-key',mapId:'DEMO_MAP_ID'})}),document:{getElementById:get,createElement:node},google:{maps:{Map:MapDouble,marker:{AdvancedMarkerElement:Marker},Polyline,InfoWindow,LatLngBounds:class{extend(){}},event:{trigger(){},addListenerOnce(){}}}}});context.window=context;
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  return {context,nodes,markers,lines};
}

test('screen loads Google renderer only and configuration/auth errors remain visible', async()=>{
 const html=fs.readFileSync('pedidos/inicio/choferes.html','utf8');
 assert.match(html,/src="\/pedidos\/inicio\/choferes-google-map.js"/);
 assert.doesNotMatch(html,/leaflet|\bL\.map|invalidateSize/);
 assert.match(html,/id="trackingMapError" role="alert"/);
 for(const status of [503,401,403]){
  const h=harness();h.context.authFetch=async()=>({ok:false,status});
  assert.equal(await h.context.initTrackingMap(),false);
  assert.equal(h.nodes.get('trackingMapError').hidden,false);
  assert.match(h.nodes.get('trackingMapError').textContent,status===503?/no está configurado/:/permisos administrativos/);
 }
 const h=harness();assert.equal(await h.context.initTrackingMap(),true);
 h.context.gm_authFailure();assert.equal(await h.context.initTrackingMap(),false);
 assert.match(h.nodes.get('trackingMapError').textContent,/no autorizó/);
});

test('Google tracking markers and trails refresh without changing camera, explicit focus remains available',async()=>{
 const h=harness();const c=h.context;
 assert.equal(await c.initTrackingMap(),true);
 const item={pedido_id:5,chofer_nombre:'Prueba',cliente:'Cliente <script>',estado:'en_ruta',latitud:-31.4,longitud:-64.18,dest_lat:-31.42,dest_lng:-64.19,timestamp:'synthetic'};
 c.renderTrackingMap([item],[]);
 assert.equal(h.markers.length,2);assert.equal(c.trackingMap.fits,1);
 h.markers[0].click();assert.match(c.trackingInfoWindow.content,/Pedido #5/);assert.match(c.trackingInfoWindow.content,/&lt;script>/);
 c.trackingMap.setCenter({lat:-31.5,lng:-64.3});c.trackingMap.setZoom(13);
 c.renderTrackingMap([{...item,latitud:-31.401}],[]);
 assert.equal(h.markers[0].map,null);assert.equal(c.trackingMap.fits,1);assert.equal(c.trackingMap.getCenter().lat,-31.5);assert.equal(c.trackingMap.getZoom(),13);
 assert.equal(h.lines.length,1);assert.equal(h.lines[0].path.length,2);
 c.focusIncident(5);assert.equal(c.trackingMap.getZoom(),16);assert.equal(c.trackingMap.getCenter().lat,-31.401);
 c.renderTrackingMap([{...item,alert:true}],[],{refit:true});assert.equal(c.trackingMap.fits,2);
 for(let i=0;i<20;i++)c.pushTrailPoint(5,-31.4-i/1000,-64.18);
 assert.equal(c.trackingTrails.get('5').length,15);
 c.renderTrackingMap([{...item,latitud:null,longitud:null,dest_lat:null,dest_lng:null}],[]);
 assert.equal(c.trackingMarkerByPedido.size,0);
 c.STATE.user.empresa_id=8;c.renderTrackingMap([],[]);assert.equal(c.trackingTrails.size,0);
});
