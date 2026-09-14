package cloud.venueprocrm.signage;

import android.app.Activity;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.view.Surface;
import android.view.TextureView;
import android.app.AlertDialog;
import android.content.Intent;
import android.provider.Settings;
import android.view.KeyEvent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.util.AtomicFile;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
 private static final String SERVER="https://ds.venueprocrm.cloud";
 private final Handler ui=new Handler(Looper.getMainLooper());
 private final ScheduledExecutorService network=Executors.newSingleThreadScheduledExecutor();
 private FrameLayout root;
 private volatile JSONObject current;
 private volatile String secret="",version="",lastError="";
 private String sequence="";
 private int index=0;
 private TextureView video;
 private MediaPlayer mediaPlayer;
 private androidx.media3.exoplayer.ExoPlayer exoPlayer;
 private FrameLayout canvas;
 private int videoWidth=0,videoHeight=0;
 private ImageView photo;
 private boolean playing=false,destroyed=false,paused=false;
 private final Runnable advance=()->playNext();
 private File assets;
 // Fuente en vivo local (ej. go2rtc en la LAN del local, o vía Tailscale si
 // el dispositivo está unido al mismo tailnet). Viene del propio manifiesto
 // (liveSource) — cuando está puesta, reemplaza la reproducción normal. El
 // VPS nunca la visita, solo la reparte; este dispositivo la abre estando
 // en la misma red que ella (o el mismo tailnet).
 // liveSourceRtsp: la misma señal pero por RTSP (server.js la deriva sola
 // cuando puede) — se prioriza sobre liveSource porque no tiene el buffer
 // de varios segundos del MP4 progresivo.
 // liveSourceWebrtc: la misma señal por WebRTC (WHEP contra go2rtc) — se
 // prioriza SOBRE RTSP. A diferencia de RTSP, WebRTC puede pedirle un
 // keyframe al encoder al conectarse (RTSP solo espera al próximo
 // programado) — es el techo real de latencia que RTSP no puede bajar
 // más (ver newLowLatencyPlayer() y issue androidx/media#1179, sin
 // resolver). Si no logra conectar (ICE falla, sin ruta a esa LAN, etc.)
 // cae solo a RTSP.
 private volatile String liveSource="",liveSourceRtsp="",liveSourceWebrtc="";
 private String livePlayingUrl="";
 private static org.webrtc.PeerConnectionFactory webrtcFactory;
 private static org.webrtc.EglBase webrtcEglBase;
 private org.webrtc.PeerConnection webrtcPc;
 // TextureViewRenderer, NO SurfaceViewRenderer — ver la nota larga en
 // playLiveWebrtc() de por qué. Mismo paquete org.webrtc, mismas
 // interfaces (VideoSink/RendererCommon), solo cambia cómo dibuja.
 private org.webrtc.TextureViewRenderer webrtcRenderer;
 // Overlay del mix (logo/promo/texto) — antes SOLO existía como preview
 // CSS en el panel web (mixOverlayHtml() en app.js), nunca se dibujaba en
 // la pantalla real. Es HERMANO de "canvas" dentro de "root" (no hijo),
 // ver syncMixOverlay()/buildMixOverlay() más abajo — así queda siempre
 // arriba de lo que haya adentro de canvas (video/foto/WebRTC) sin pelear
 // por el orden en que cada método de reproducción agrega sus vistas.
 private FrameLayout mixOverlay;
 // Última mezcla YA aplicada (comparación por texto) — layoutDisplay()
 // puede llamarse seguido sin que el mix haya cambiado de verdad (cambio
 // de tamaño de video, rotación, etc.); sin este chequeo, syncMixOverlay()
 // reconstruiría y volvería a hacer fade-in del overlay en cada una de
 // esas llamadas, un parpadeo molesto en vez de aparecer una sola vez.
 private String lastMixJson;
 // Las imágenes del mix (promo/logo) son assets ya subidos — se piden por
 // HTTP autenticado (como el manifiesto) y se cachean en memoria por URL,
 // porque layoutDisplay() se puede llamar seguido y no tiene sentido
 // re-descargar la misma imagen cada vez.
 private final Map<String,Bitmap> mixImageCache=new ConcurrentHashMap<>();
 // Overlay de alerta de emergencia — SIEMPRE arriba de todo lo demás
 // (incluido mixOverlay: se agrega a "root" DESPUÉS de él en cada
 // syncAlertOverlay(), y FrameLayout dibuja los hijos más nuevos encima).
 // A diferencia del mix, no depende de que haya señal en vivo — funciona
 // igual con la lista normal de fotos/videos.
 private FrameLayout alertOverlay;
 private Runnable alertBlinkRunnable;
 @Override public void onCreate(Bundle b){super.onCreate(b);
  getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  root=new FrameLayout(this);root.setBackgroundColor(Color.BLACK);setContentView(root);root.setClipChildren(true);root.addOnLayoutChangeListener((v,l,t,r,bottom,ol,ot,or,ob)->{if(r-l!=or-ol||bottom-t!=ob-ot)layoutDisplay();});
  assets=new File(getFilesDir(),"media");assets.mkdirs();
  secret=getPreferences(0).getString("secret","");
  try{current=new JSONObject(new String(new AtomicFile(new File(getFilesDir(),"manifest.json")).readFully(),StandardCharsets.UTF_8));version=current.getString("version");liveSource=current.optString("liveSource","");liveSourceRtsp=current.optString("liveSourceRtsp","");liveSourceWebrtc=current.optString("liveSourceWebrtc","");}catch(Exception ignored){}
  if(!liveSource.isEmpty())playLive(liveSource);else if(current!=null)playNext();else{String saved=getPreferences(0).getString("pairQr","");if(!saved.isEmpty()){try{byte[] bytes=Base64.decode(saved,Base64.DEFAULT);showPair(BitmapFactory.decodeByteArray(bytes,0,bytes.length),getPreferences(0).getString("pairCode",""));}catch(Exception ignored){message("VenuePro Signage\nConectando tu pantalla…");}}else message("VenuePro Signage\nConectando tu pantalla…");}
  network.execute(this::syncLoop);
 }
 // En vez de un sondeo a intervalo FIJO (antes 20s siempre, cambie algo o
 // no), esto encadena sync() de inmediato apenas termina el anterior — la
 // pausa real ahora la pone el propio servidor (long-polling, ver
 // MANIFEST_WAIT_MS en server.js): si nada cambió se demora ahí adentro
 // unos ~18s antes de contestar iguales, y si SÍ cambió algo (cambiar de
 // canal, apagar la señal en vivo, una mezcla nueva) contesta casi al
 // instante. Solo se mete una pausa acá cuando hubo un error de verdad
 // (red caída, servidor no responde), para no martillarlo en un loop
 // cerrado mientras esté mal.
 private void syncLoop(){
  if(destroyed)return;
  boolean ok=sync();
  // Mínimo 1s SIEMPRE, incluso si salió bien — no es solo cosmético: si
  // el servidor no está devolviendo el long-poll real por el motivo que
  // sea (versión vieja del server sin este soporte, algún proxy que no
  // deja la conexión abierta, etc.), esto evita que el loop se vuelva un
  // bucle cerrado disparando pedidos sin parar — eso satura la red y la
  // CPU de la propia tablet, y se ve como la pantalla congelándose. Con
  // el long-poll funcionando de verdad (servidor esperando ~18s cuando no
  // hay nada nuevo) este piso de 1s no se nota en nada.
  network.schedule(this::syncLoop,ok?1:5,TimeUnit.SECONDS);
 }
 private HttpURLConnection connection(String url,String method)throws Exception{
  URL parsed=new URL(url);if(!parsed.getProtocol().equals("https")||!parsed.getHost().equals(new URL(SERVER).getHost()))throw new IOException("Servidor no permitido");
  HttpURLConnection c=(HttpURLConnection)parsed.openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(60000);c.setRequestMethod(method);
  if(!secret.isEmpty())c.setRequestProperty("Authorization","Bearer "+secret);return c;
 }
 private JSONObject request(String path,JSONObject body)throws Exception{
  HttpURLConnection c=connection(SERVER+path,body==null?"GET":"POST");
  try{if(body!=null){c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");try(OutputStream o=c.getOutputStream()){o.write(body.toString().getBytes(StandardCharsets.UTF_8));}}
   int code=c.getResponseCode();if(code==401||code==410)throw new Unpaired();if(code<200||code>=300)throw new IOException("Servidor: "+code);
   try(InputStream in=c.getInputStream()){return new JSONObject(new String(read(in,2*1024*1024),StandardCharsets.UTF_8));}
  }finally{c.disconnect();}
 }
 private byte[] read(InputStream in,int limit)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>limit)throw new IOException("Respuesta demasiado grande");out.write(b,0,n);}return out.toByteArray();}
 private static class Unpaired extends IOException{}
 // Devuelve true si el ciclo salió limpio (para que syncLoop() decida si
 // encadena el siguiente ya mismo o espera un poco por haber fallado).
 private boolean sync(){
  if(destroyed)return true;
  try{
   if(secret.isEmpty()){
    JSONObject pair=request("/api/pair/start",new JSONObject());secret=pair.getString("secret");getPreferences(0).edit().putString("secret",secret).apply();
    String code=pair.getString("code"),data=pair.getString("qr").split(",",2)[1];byte[] bytes=Base64.decode(data,Base64.DEFAULT);Bitmap qr=BitmapFactory.decodeByteArray(bytes,0,bytes.length);
    getPreferences(0).edit().putString("pairQr",data).putString("pairCode",code).apply();
    ui.post(()->showPair(qr,code));
   }
   // since/wait activan el long-polling del lado del servidor — mientras
   // la versión no cambie de verdad, la respuesta se demora ahí adentro
   // en vez de contestar ya con lo mismo de siempre (ver server.js).
   JSONObject next=request("/api/player/manifest?since="+URLEncoder.encode(version,"UTF-8")+"&wait=1",null);
   if(!next.optBoolean("paired"))return true;
   getPreferences(0).edit().remove("pairQr").remove("pairCode").apply();
   if(!next.getString("version").equals(version)){
    LinkedHashMap<String,JSONObject> all=new LinkedHashMap<>();collect(next.getJSONArray("items"),all);
    JSONArray schedules=next.optJSONArray("schedules");if(schedules!=null)for(int n=0;n<schedules.length();n++)collect(schedules.getJSONObject(n).getJSONArray("items"),all);
    for(JSONObject item:all.values())download(item);
    // Keep the previous manifest active until every asset verifies successfully.
    AtomicFile file=new AtomicFile(new File(getFilesDir(),"manifest.json"));FileOutputStream out=null;
    try{out=file.startWrite();out.write(next.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}catch(Exception e){if(out!=null)file.failWrite(out);throw e;}
    // Si YA estaba en vivo y este manifiesto apaga esa fuente, hay que
    // forzar el paso a la lista aunque "playing" siga en true — nada
    // pone playing=false al salir de en vivo (ahí no hay "onCompletion"
    // como en un video), así que sin este chequeo la condición de abajo
    // (!playing&&!paused) nunca se cumplía y la pantalla se quedaba
    // congelada en la última señal en vivo para siempre, sin volver
    // nunca a la lista de fotos/videos. Bug real, no solo caso raro.
    boolean saliendoDeEnVivo=!liveSource.isEmpty()&&next.optString("liveSource","").isEmpty();
    current=next;version=next.getString("version");lastError="";liveSource=next.optString("liveSource","");liveSourceRtsp=next.optString("liveSourceRtsp","");liveSourceWebrtc=next.optString("liveSourceWebrtc","");
    ui.post(()->{sequence="";layoutDisplay();
     if(!liveSource.isEmpty())playLive(liveSource);
     else if(next.optBoolean("paused"))stopPlayback();
     else if(saliendoDeEnVivo||(!playing&&!paused))playNext();});
   }
   request("/api/player/heartbeat",new JSONObject().put("version",version).put("error",lastError));
   return true;
  }catch(Unpaired e){
   secret="";version="";current=null;getPreferences(0).edit().remove("secret").remove("pairQr").remove("pairCode").apply();new AtomicFile(new File(getFilesDir(),"manifest.json")).delete();
   ui.post(()->{stopPlayback();message("Pantalla desvinculada\nGenerando un nuevo código…");});
   return false;
  }catch(Exception e){lastError=e.getMessage()==null?"Error de sincronización":e.getMessage();if(current==null)ui.post(()->{if(!playing)message("No se pudo conectar\nSe intentará de nuevo automáticamente");});try{if(!secret.isEmpty())request("/api/player/heartbeat",new JSONObject().put("version",version).put("error",lastError));}catch(Exception ignored){}return false;}
 }
 // Un item de tipo "live" (canal embebido en una lista, ver
 // deviceManifest()/expand() en server.js) no es un archivo que se
 // descargue y cachee por sha — se transmite en vivo cuando le toca su
 // turno, así que no entra al mapa de descargas.
 private void collect(JSONArray list,Map<String,JSONObject> out)throws JSONException{for(int i=0;i<list.length();i++){JSONObject item=list.getJSONObject(i);if("live".equals(item.optString("type","")))continue;out.put(item.getString("sha"),item);}}
 private void download(JSONObject item)throws Exception{
  String sha=item.getString("sha");if(!sha.matches("[a-f0-9]{64}"))throw new IOException("Archivo inválido");
  File target=new File(assets,sha);long expected=item.getLong("size");if(target.exists()&&target.length()==expected&&checksum(target).equals(sha))return;
  File temp=new File(assets,sha+".part");if(assets.getUsableSpace()<expected+20*1024*1024)throw new IOException("Espacio insuficiente. Se mantiene la última lista.");
  HttpURLConnection c=connection(item.getString("url"),"GET");
  try{if(c.getResponseCode()!=200)throw new IOException("Descarga no disponible");MessageDigest digest=MessageDigest.getInstance("SHA-256");long size=0;
   try(InputStream in=c.getInputStream();FileOutputStream out=new FileOutputStream(temp)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1){size+=n;if(size>expected)throw new IOException("Tamaño inválido");out.write(b,0,n);digest.update(b,0,n);}out.getFD().sync();}
   if(size!=expected||!hex(digest.digest()).equals(sha))throw new IOException("Verificación de archivo fallida");
   if(target.exists()&&!target.delete())throw new IOException("No se pudo reemplazar archivo");if(!temp.renameTo(target))throw new IOException("No se pudo guardar archivo");
  }finally{c.disconnect();if(temp.exists())temp.delete();}
 }
 private String checksum(File f)throws Exception{MessageDigest d=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(f)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)d.update(b,0,n);}return hex(d.digest());}
 private String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte v:b)s.append(String.format(Locale.ROOT,"%02x",v&255));return s.toString();}
 private JSONArray selected(JSONObject manifest)throws Exception{
  JSONArray schedules=manifest.optJSONArray("schedules");
  if(schedules!=null)for(int n=0;n<schedules.length();n++){
   JSONObject s=schedules.getJSONObject(n);ZonedDateTime now=ZonedDateTime.now(ZoneId.of(s.getString("timezone")));String day=now.toLocalDate().toString(),time=String.format(Locale.ROOT,"%02d:%02d",now.getHour(),now.getMinute());
   String from=s.optString("fromDate"),to=s.optString("toDate");if(!from.isEmpty()&&day.compareTo(from)<0||!to.isEmpty()&&day.compareTo(to)>0)continue;
   if(time.compareTo(s.getString("start"))<0||time.compareTo(s.getString("end"))>=0)continue;
   JSONArray days=s.getJSONArray("days");for(int d=0;d<days.length();d++)if(days.getInt(d)==now.getDayOfWeek().getValue()%7)return s.getJSONArray("items");
  }
  return manifest.getJSONArray("items");
 }
 private void stopPlayback(){ui.removeCallbacks(advance);if(alertBlinkRunnable!=null){ui.removeCallbacks(alertBlinkRunnable);alertBlinkRunnable=null;}if(mediaPlayer!=null){mediaPlayer.release();mediaPlayer=null;}if(exoPlayer!=null){exoPlayer.release();exoPlayer=null;}if(webrtcPc!=null){webrtcPc.close();webrtcPc=null;}if(webrtcRenderer!=null){webrtcRenderer.release();webrtcRenderer=null;}video=null;canvas=null;videoWidth=0;videoHeight=0;if(photo!=null){photo.setImageDrawable(null);photo=null;}mixOverlay=null;lastMixJson=null;alertOverlay=null;livePlayingUrl="";playing=false;root.removeAllViews();}
 // Si el manifiesto trae liveSourceWebrtc, se intenta ESA primero — WebRTC
 // puede pedirle un keyframe al encoder al conectarse, cosa que RTSP no
 // puede hacer (solo espera al próximo programado). Si no logra conectar
 // (ICE falla, sin ruta a esa LAN, etc.) cae solo a RTSP; si tampoco hay
 // RTSP derivable, cae al MediaPlayer+MP4 de siempre (playLiveFallback).
 private void playLive(String url){
  if(destroyed||paused)return;
  if(!liveSourceWebrtc.isEmpty()){playLiveWebrtc(liveSourceWebrtc,()->playLiveFallback(url));return;}
  playLiveFallback(url);
 }
 // Si el manifiesto trae liveSourceRtsp (go2rtc), se usa ESA — RTSP no
 // tiene el buffer de varios segundos del MP4 progresivo (el que usa el
 // proxy del panel web, pensado para navegadores que no pueden abrir
 // RTSP directo). Si no hay RTSP derivable (fuente en vivo genérica, no
 // go2rtc), cae al MediaPlayer+MP4 de siempre.
 private void playLiveFallback(String url){
  if(destroyed||paused)return;
  if(!liveSourceRtsp.isEmpty()){playLiveRtsp(liveSourceRtsp);return;}
  if(url.equals(livePlayingUrl))return; // ya está en esa URL
  stopPlayback();
  livePlayingUrl=url;playing=true;
  canvas=new FrameLayout(this);canvas.setClipChildren(true);root.addView(canvas);layoutDisplay();
  video=new TextureView(this);canvas.addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
  video.setSurfaceTextureListener(new TextureView.SurfaceTextureListener(){
   public void onSurfaceTextureAvailable(SurfaceTexture texture,int width,int height){
    try{final MediaPlayer player=new MediaPlayer();mediaPlayer=player;Surface surface=new Surface(texture);player.setSurface(surface);surface.release();player.setDataSource(url);
     player.setOnPreparedListener(mp->{if(mp!=mediaPlayer)return;videoWidth=mp.getVideoWidth();videoHeight=mp.getVideoHeight();layoutDisplay();mp.start();});
     player.setOnVideoSizeChangedListener((mp,w,h)->{videoWidth=w;videoHeight=h;layoutDisplay();});
     // Una señal en vivo se puede cortar (cámara/encoder se reinicia, red
     // parpadea) — a diferencia de un video local, aquí sí vale la pena
     // reintentar sola en vez de darse por vencida.
     player.setOnErrorListener((mp,what,extra)->{lastError="Señal en vivo interrumpida, reintentando…";livePlayingUrl="";ui.postDelayed(()->{if(url.equals(liveSource))playLive(url);},2000);return true;});
     player.prepareAsync();
    }catch(Exception error){lastError="No se pudo abrir la señal en vivo";livePlayingUrl="";ui.postDelayed(()->{if(url.equals(liveSource))playLive(url);},3000);}
   }
   public void onSurfaceTextureSizeChanged(SurfaceTexture texture,int width,int height){}
   public boolean onSurfaceTextureDestroyed(SurfaceTexture texture){return true;}
   public void onSurfaceTextureUpdated(SurfaceTexture texture){}
  });
 }
 // SdpObserver con métodos vacíos — la interfaz de WebRTC exige los 4,
 // pero la mayoría de las veces solo hace falta reaccionar a uno.
 private static class SimpleSdpObserver implements org.webrtc.SdpObserver {
  public void onCreateSuccess(org.webrtc.SessionDescription sdp){}
  public void onSetSuccess(){}
  public void onCreateFailure(String error){}
  public void onSetFailure(String error){}
 }
 // PeerConnectionFactory es caro de crear (inicializa el motor nativo de
 // WebRTC) — se hace una sola vez por proceso, no por cada vez que se
 // prende un canal.
 private static synchronized void ensureWebrtcFactory(android.content.Context context){
  if(webrtcFactory!=null)return;
  org.webrtc.PeerConnectionFactory.initialize(org.webrtc.PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());
  webrtcEglBase=org.webrtc.EglBase.create();
  webrtcFactory=org.webrtc.PeerConnectionFactory.builder()
   .setVideoDecoderFactory(new org.webrtc.DefaultVideoDecoderFactory(webrtcEglBase.getEglBaseContext()))
   .setVideoEncoderFactory(new org.webrtc.DefaultVideoEncoderFactory(webrtcEglBase.getEglBaseContext(),true,true))
   .createPeerConnectionFactory();
 }
 // WebRTC directo contra go2rtc (WHEP: se manda la oferta SDP por POST, se
 // recibe la respuesta) — sin servidores STUN/TURN a propósito, porque el
 // reproductor y go2rtc están en la MISMA LAN (no hay NAT que atravesar
 // entre ellos). Si en 4s no logra conectar de verdad (no solo que la
 // señalización funcionó — hay que esperar a que ICE conecte, que es
 // cuando el video ya está fluyendo), se abandona y se llama a
 // "fallback" (normalmente playLiveRtsp). Es lo mismo que ya hace la
 // vista previa del panel web, solo que en Java en vez de JavaScript.
 private void playLiveWebrtc(String webrtcUrl,Runnable fallback){
  if(destroyed||paused)return;
  if(webrtcUrl.equals(livePlayingUrl))return; // ya está en esa URL
  stopPlayback();
  livePlayingUrl=webrtcUrl;playing=true;
  ensureWebrtcFactory(getApplicationContext());
  canvas=new FrameLayout(this);canvas.setClipChildren(true);root.addView(canvas);layoutDisplay();
  // OJO, esto ya se cambió una vez: se probó con SurfaceViewRenderer +
  // setZOrderMediaOverlay(false)/setZOrderOnTop(false) para forzar el mix
  // a dibujarse encima, y en el papel es lo correcto — pero en la pantalla
  // física real (Google TV / Android TV box) el mix seguía sin verse
  // aunque sí aparecía en el preview del panel web, incluso con APK
  // reinstalada limpia. La explicación: SurfaceView no dibuja dentro de la
  // ventana normal de la app, dibuja en una superficie de video APARTE que
  // Android compone por fuera (frecuentemente con un plano de hardware
  // dedicado en cajitas/TV — más barato en batería/GPU). Las flags de
  // Z-order le piden a ESA composición que vaya detrás, pero en varios
  // SoCs de set-top-box ese plano de hardware ignora el orden normal de
  // vistas de todos modos, así que cualquier View agregada encima (el
  // mixOverlay) puede quedar tapada sin importar qué se le pida.
  // TextureViewRenderer, en cambio, dibuja el video como una View NORMAL
  // más dentro del árbol (usa la GPU pero compone junto con el resto de la
  // ventana) — se apila con mixOverlay/alertOverlay exactamente en el
  // orden en que se agregan a "root", como CUALQUIER otra vista de esta
  // pantalla (photo, video de TextureView en RTSP/MP4). Un poco más caro
  // que SurfaceView, pero en un video de señalización (no un juego a 60fps
  // exigente) no se nota, y es la única forma de garantizar que el mix se
  // vea sin depender de cómo cada fabricante de TV box implementó su
  // compositor de video.
  webrtcRenderer=new org.webrtc.TextureViewRenderer(this);
  webrtcRenderer.init(webrtcEglBase.getEglBaseContext(),null);
  canvas.addView(webrtcRenderer,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
  layoutDisplay(); // fija el scalingType (cover/contain) del renderer recién creado
  final boolean[] gaveUp={false};
  final Runnable giveUp=()->ui.post(()->{
   if(gaveUp[0]||!webrtcUrl.equals(livePlayingUrl))return; gaveUp[0]=true;
   livePlayingUrl="";lastError="WebRTC no logró conectar, usando RTSP…";fallback.run();
  });
  final org.webrtc.PeerConnection[] pcHolder=new org.webrtc.PeerConnection[1];
  org.webrtc.PeerConnection pc=webrtcFactory.createPeerConnection(new org.webrtc.PeerConnection.RTCConfiguration(new ArrayList<>()),new org.webrtc.PeerConnection.Observer(){
   @Override public void onSignalingChange(org.webrtc.PeerConnection.SignalingState s){}
   @Override public void onIceConnectionChange(org.webrtc.PeerConnection.IceConnectionState s){
    if(s==org.webrtc.PeerConnection.IceConnectionState.FAILED||s==org.webrtc.PeerConnection.IceConnectionState.DISCONNECTED||s==org.webrtc.PeerConnection.IceConnectionState.CLOSED)giveUp.run();
   }
   @Override public void onIceConnectionReceivingChange(boolean receiving){}
   @Override public void onIceGatheringChange(org.webrtc.PeerConnection.IceGatheringState s){}
   @Override public void onIceCandidate(org.webrtc.IceCandidate candidate){}
   @Override public void onIceCandidatesRemoved(org.webrtc.IceCandidate[] candidates){}
   @Override public void onAddStream(org.webrtc.MediaStream stream){}
   @Override public void onRemoveStream(org.webrtc.MediaStream stream){}
   @Override public void onDataChannel(org.webrtc.DataChannel channel){}
   @Override public void onRenegotiationNeeded(){}
   @Override public void onAddTrack(org.webrtc.RtpReceiver receiver,org.webrtc.MediaStream[] streams){
    org.webrtc.MediaStreamTrack track=receiver.track();
    if(track instanceof org.webrtc.VideoTrack){
     org.webrtc.VideoTrack videoTrack=(org.webrtc.VideoTrack)track;
     ui.post(()->{if(pcHolder[0]==webrtcPc&&webrtcRenderer!=null)videoTrack.addSink(webrtcRenderer);});
    }
   }
  });
  pcHolder[0]=pc;webrtcPc=pc;
  if(pc==null){giveUp.run();return;}
  pc.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,new org.webrtc.RtpTransceiver.RtpTransceiverInit(org.webrtc.RtpTransceiver.RtpTransceiverDirection.RECV_ONLY));
  pc.createOffer(new SimpleSdpObserver(){
   @Override public void onCreateSuccess(org.webrtc.SessionDescription offer){
    pc.setLocalDescription(new SimpleSdpObserver(),offer);
    network.execute(()->{
     try{
      HttpURLConnection c=(HttpURLConnection)new URL(webrtcUrl).openConnection();
      c.setConnectTimeout(4000);c.setReadTimeout(4000);c.setRequestMethod("POST");c.setDoOutput(true);
      c.setRequestProperty("Content-Type","application/sdp");
      try(OutputStream out=c.getOutputStream()){out.write(offer.description.getBytes(StandardCharsets.UTF_8));}
      int code=c.getResponseCode();
      if(code<200||code>=300)throw new IOException("go2rtc respondió "+code);
      String answerSdp=new String(read(c.getInputStream(),65536),StandardCharsets.UTF_8);
      c.disconnect();
      ui.post(()->{if(pcHolder[0]==webrtcPc)pc.setRemoteDescription(new SimpleSdpObserver(),new org.webrtc.SessionDescription(org.webrtc.SessionDescription.Type.ANSWER,answerSdp));});
     }catch(Exception e){giveUp.run();}
    });
   }
   @Override public void onCreateFailure(String error){giveUp.run();}
  },new org.webrtc.MediaConstraints());
  ui.postDelayed(()->{
   if(pcHolder[0]==webrtcPc&&pc.iceConnectionState()!=org.webrtc.PeerConnection.IceConnectionState.CONNECTED&&pc.iceConnectionState()!=org.webrtc.PeerConnection.IceConnectionState.COMPLETED)giveUp.run();
  },4000);
 }
 // ExoPlayer sobre RTSP-TCP (más confiable detrás de NAT/firewall que UDP,
 // el costo de latencia es mínimo) — esto sí es tiempo casi real.
 //
 // El buffer POR DEFECTO de ExoPlayer (DefaultLoadControl) está pensado
 // para streaming bajo demanda, no para en vivo — junta hasta varios
 // segundos antes de empezar a reproducir, lo que se siente como
 // latencia aunque el transporte (RTSP-TCP) ya sea casi instantáneo.
 // Para la señal en vivo SIEMPRE se prioriza latencia mínima sobre
 // resistencia a cortes de red (la señal ya viene por LAN, poca pérdida
 // esperada) — un buffer pequeño + LiveConfiguration con target bajo le
 // dice al reproductor "quédate pegado al borde en vivo, no acumules".
 //
 // OJO: bajar el "-g" del ffmpeg que arma la señal en go2rtc (menos
 // cuadros entre keyframes) SÍ ayuda un poco, pero media3/ExoPlayer tiene
 // un límite propio de latencia en su implementación de RTSP que ningún
 // ajuste de acá puede bajar más — issue abierto y sin resolver del
 // propio proyecto: https://github.com/androidx/media/issues/1179 (otro
 // desarrollador reporta el mismo síntoma, "2-3s de atraso", con los
 // mismos intentos de buffer mínimo, sin solución). Por eso WebRTC
 // (playLiveWebrtc, más abajo) se intenta SIEMPRE primero cuando el
 // manifiesto lo trae — este método (RTSP) queda como respaldo.
 private androidx.media3.exoplayer.ExoPlayer newLowLatencyPlayer(){
  androidx.media3.exoplayer.DefaultLoadControl loadControl=new androidx.media3.exoplayer.DefaultLoadControl.Builder()
   .setBufferDurationsMs(500,2000,250,250).build();
  return new androidx.media3.exoplayer.ExoPlayer.Builder(this).setLoadControl(loadControl).build();
 }
 private androidx.media3.common.MediaItem lowLatencyRtspItem(String rtspUrl){
  return new androidx.media3.common.MediaItem.Builder().setUri(rtspUrl)
   .setLiveConfiguration(new androidx.media3.common.MediaItem.LiveConfiguration.Builder().setTargetOffsetMs(500).build())
   .build();
 }
 @androidx.media3.common.util.UnstableApi
 private void playLiveRtsp(String rtspUrl){
  if(destroyed||paused)return;
  if(rtspUrl.equals(livePlayingUrl))return; // ya está en esa URL
  stopPlayback();
  livePlayingUrl=rtspUrl;playing=true;
  canvas=new FrameLayout(this);canvas.setClipChildren(true);root.addView(canvas);layoutDisplay();
  video=new TextureView(this);canvas.addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
  final androidx.media3.exoplayer.ExoPlayer player=newLowLatencyPlayer();
  exoPlayer=player;
  player.setVideoTextureView(video);
  androidx.media3.exoplayer.source.MediaSource source=new androidx.media3.exoplayer.rtsp.RtspMediaSource.Factory()
   .setForceUseRtpTcp(true)
   .createMediaSource(lowLatencyRtspItem(rtspUrl));
  player.setMediaSource(source);
  player.addListener(new androidx.media3.common.Player.Listener(){
   @Override public void onVideoSizeChanged(androidx.media3.common.VideoSize size){videoWidth=size.width;videoHeight=size.height;layoutDisplay();}
   @Override public void onPlayerError(androidx.media3.common.PlaybackException error){
    if(player!=exoPlayer)return;
    lastError="Señal en vivo interrumpida, reintentando…";livePlayingUrl="";
    ui.postDelayed(()->{if(rtspUrl.equals(liveSourceRtsp))playLiveRtsp(rtspUrl);},2000);
   }
  });
  player.setPlayWhenReady(true);
  player.prepare();
 }
 private void playNext(){
  if(destroyed||paused||!liveSource.isEmpty())return;stopPlayback();JSONObject manifest=current;if(manifest==null)return;
  try{
   if(manifest.optBoolean("paused")){message("Reproducción pausada\nReanuda desde el gestor");ui.postDelayed(advance,10000);return;}
   JSONArray list=selected(manifest);String key=list.toString();if(!key.equals(sequence)){sequence=key;index=0;}
   if(list.length()==0){message("Pantalla vinculada\nEsperando contenido programado");ui.postDelayed(advance,10000);return;}
   JSONObject item=list.getJSONObject(index++%list.length());
   // Un item de tipo "live" es un canal metido dentro de la lista (no la
   // fuente en vivo persistente de la pantalla, esa es liveSource/playLive
   // más arriba) — se transmite en su turno y avanza solo tras "seconds",
   // igual que una foto, en vez de completarse solo como un video normal.
   if("live".equals(item.optString("type",""))){playRotationLive(item);return;}
   File file=new File(assets,item.getString("sha"));playing=true;canvas=new FrameLayout(this);canvas.setClipChildren(true);root.addView(canvas);layoutDisplay();
   if(item.getString("type").startsWith("video/")){
    video=new TextureView(this);canvas.addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
    video.setSurfaceTextureListener(new TextureView.SurfaceTextureListener(){
     public void onSurfaceTextureAvailable(SurfaceTexture texture,int width,int height){
      try{final MediaPlayer player=new MediaPlayer();mediaPlayer=player;Surface surface=new Surface(texture);player.setSurface(surface);surface.release();player.setDataSource(file.getAbsolutePath());
       player.setOnPreparedListener(mp->{if(mp!=mediaPlayer)return;videoWidth=mp.getVideoWidth();videoHeight=mp.getVideoHeight();layoutDisplay();mp.start();});
       player.setOnVideoSizeChangedListener((mp,w,h)->{videoWidth=w;videoHeight=h;layoutDisplay();});
       player.setOnCompletionListener(mp->playNext());player.setOnErrorListener((mp,what,extra)->{lastError="Video no compatible: "+what;ui.postDelayed(advance,1500);return true;});player.prepareAsync();
      }catch(Exception error){lastError="No se pudo abrir el video";ui.postDelayed(advance,1500);}
     }
     public void onSurfaceTextureSizeChanged(SurfaceTexture texture,int width,int height){}
     public boolean onSurfaceTextureDestroyed(SurfaceTexture texture){return true;}
     public void onSurfaceTextureUpdated(SurfaceTexture texture){}
    });
   }else{
    BitmapFactory.Options opts=new BitmapFactory.Options();opts.inJustDecodeBounds=true;BitmapFactory.decodeFile(file.getAbsolutePath(),opts);int max=Math.max(getResources().getDisplayMetrics().widthPixels,getResources().getDisplayMetrics().heightPixels);opts.inSampleSize=1;while(Math.max(opts.outWidth,opts.outHeight)/opts.inSampleSize>max*2)opts.inSampleSize*=2;opts.inJustDecodeBounds=false;
    Bitmap bitmap=BitmapFactory.decodeFile(file.getAbsolutePath(),opts);if(bitmap==null)throw new IOException("Imagen no compatible");photo=new ImageView(this);photo.setScaleType(ImageView.ScaleType.CENTER_CROP);photo.setImageBitmap(bitmap);canvas.addView(photo,new FrameLayout.LayoutParams(-1,-1));layoutDisplay();ui.postDelayed(advance,item.getInt("seconds")*1000L);
   }
  }catch(Exception e){lastError="No se pudo reproducir el archivo";ui.postDelayed(advance,3000);}
 }
 // Canal embebido en una lista: se reproduce igual que un video/foto de
 // la rotación, solo que en vivo (RTSP si go2rtc lo permite, si no MP4
 // por HTTP) y avanzando al siguiente item pasados los "seconds"
 // configurados en vez de esperar a que "termine" (un stream no termina
 // solo). Distinto de liveSource/playLive/playLiveRtsp — esos son la
 // fuente en vivo PERSISTENTE de la pantalla (sin "seconds", sin avanzar).
 @androidx.media3.common.util.UnstableApi
 private void playRotationLive(JSONObject item){
  playing=true;canvas=new FrameLayout(this);canvas.setClipChildren(true);root.addView(canvas);layoutDisplay();
  video=new TextureView(this);canvas.addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
  long millis=Math.max(1,item.optInt("seconds",10))*1000L;
  String rtsp=item.optString("rtsp","");
  if(!rtsp.isEmpty()){
   final androidx.media3.exoplayer.ExoPlayer player=newLowLatencyPlayer();
   exoPlayer=player;player.setVideoTextureView(video);
   androidx.media3.exoplayer.source.MediaSource source=new androidx.media3.exoplayer.rtsp.RtspMediaSource.Factory().setForceUseRtpTcp(true).createMediaSource(lowLatencyRtspItem(rtsp));
   player.setMediaSource(source);
   player.addListener(new androidx.media3.common.Player.Listener(){
    @Override public void onVideoSizeChanged(androidx.media3.common.VideoSize size){videoWidth=size.width;videoHeight=size.height;layoutDisplay();}
    @Override public void onPlayerError(androidx.media3.common.PlaybackException error){if(player!=exoPlayer)return;lastError="Canal no disponible, saltando…";ui.removeCallbacks(advance);ui.postDelayed(advance,1500);}
   });
   player.setPlayWhenReady(true);player.prepare();
   ui.postDelayed(advance,millis);
   return;
  }
  try{String url=item.getString("url");
   video.setSurfaceTextureListener(new TextureView.SurfaceTextureListener(){
    public void onSurfaceTextureAvailable(SurfaceTexture texture,int width,int height){
     try{final MediaPlayer player=new MediaPlayer();mediaPlayer=player;Surface surface=new Surface(texture);player.setSurface(surface);surface.release();player.setDataSource(url);
      player.setOnPreparedListener(mp->{if(mp!=mediaPlayer)return;videoWidth=mp.getVideoWidth();videoHeight=mp.getVideoHeight();layoutDisplay();mp.start();});
      player.setOnVideoSizeChangedListener((mp,w,h)->{videoWidth=w;videoHeight=h;layoutDisplay();});
      player.setOnErrorListener((mp,what,extra)->{lastError="Canal no disponible, saltando…";ui.removeCallbacks(advance);ui.postDelayed(advance,1500);return true;});
      player.prepareAsync();
     }catch(Exception error){lastError="No se pudo abrir el canal";ui.removeCallbacks(advance);ui.postDelayed(advance,1500);}
    }
    public void onSurfaceTextureSizeChanged(SurfaceTexture texture,int width,int height){}
    public boolean onSurfaceTextureDestroyed(SurfaceTexture texture){return true;}
    public void onSurfaceTextureUpdated(SurfaceTexture texture){}
   });
   ui.postDelayed(advance,millis);
  }catch(Exception e){lastError="No se pudo abrir el canal";ui.postDelayed(advance,1500);}
 }
 private void layoutDisplay(){
  if(canvas==null||current==null)return;
  int width=root.getWidth(),height=root.getHeight();if(width==0||height==0){root.post(this::layoutDisplay);return;}
  JSONObject settings=current.optJSONObject("display");String orientation=settings==null?"auto":settings.optString("orientation","auto");
  int angle=(settings==null?0:settings.optInt("rotation",0))+((orientation.equals("portrait")&&width>height||orientation.equals("landscape")&&height>width)?90:0);angle%=360;
  int w=angle%180==0?width:height,h=angle%180==0?height:width;canvas.setLayoutParams(new FrameLayout.LayoutParams(w,h,Gravity.CENTER));canvas.setRotation(angle);
  boolean cover=settings==null||!settings.optString("fit","cover").equals("contain");
  if(photo!=null)photo.setScaleType(cover?ImageView.ScaleType.CENTER_CROP:ImageView.ScaleType.FIT_CENTER);
  if(video!=null&&videoWidth>0&&videoHeight>0){double scale=cover?Math.max((double)w/videoWidth,(double)h/videoHeight):Math.min((double)w/videoWidth,(double)h/videoHeight);video.setLayoutParams(new FrameLayout.LayoutParams((int)Math.round(videoWidth*scale),(int)Math.round(videoHeight*scale),Gravity.CENTER));}
  // SurfaceViewRenderer (WebRTC) resuelve su propio recorte/ajuste — no
  // hace falta calcularle el tamaño a mano como al TextureView de arriba.
  if(webrtcRenderer!=null)webrtcRenderer.setScalingType(cover?org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FILL:org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT);
  syncMixOverlay();
  if(mixOverlay!=null){mixOverlay.setLayoutParams(new FrameLayout.LayoutParams(w,h,Gravity.CENTER));mixOverlay.setRotation(angle);}
  // La alerta va DESPUÉS del mix a propósito — se agrega más tarde a
  // "root", así que FrameLayout la dibuja arriba de todo lo demás.
  syncAlertOverlay();
  if(alertOverlay!=null){alertOverlay.setLayoutParams(new FrameLayout.LayoutParams(w,h,Gravity.CENTER));alertOverlay.setRotation(angle);}
 }
 // Agrega/reconstruye/quita la alerta de emergencia según el manifiesto
 // actual — mismo patrón que syncMixOverlay(), pero SIN el chequeo de
 // liveSource (una alerta tiene sentido con cualquier cosa en pantalla).
 private void syncAlertOverlay(){
  if(alertOverlay!=null){root.removeView(alertOverlay);alertOverlay=null;}
  if(alertBlinkRunnable!=null){ui.removeCallbacks(alertBlinkRunnable);alertBlinkRunnable=null;}
  JSONObject alert=current==null?null:current.optJSONObject("alert");
  if(alert==null||canvas==null)return;
  alertOverlay=buildAlertOverlay(alert);
  root.addView(alertOverlay,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
 }
 // 'info'/'warning': franja arriba, no tapa el contenido. 'critical': toma
 // TODA la pantalla y parpadea — para que sea imposible de ignorar por
 // descuido (un aviso de emergencia real, no un aviso más).
 private FrameLayout buildAlertOverlay(JSONObject alert){
  String text=alert.optString("text","");
  String level=alert.optString("level","warning");
  FrameLayout overlay=new FrameLayout(this);
  if("critical".equals(level)){
   final int solid=Color.argb(235,196,42,34),dim=Color.argb(120,196,42,34);
   overlay.setBackgroundColor(solid);
   TextView t=new TextView(this);t.setText("🚨 "+text);t.setTextColor(Color.WHITE);t.setTextSize(28);t.setTypeface(null,android.graphics.Typeface.BOLD);t.setGravity(Gravity.CENTER);t.setPadding(40,40,40,40);
   t.setShadowLayer(6,0,2,Color.argb(180,0,0,0));
   overlay.addView(t,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
   alertBlinkRunnable=new Runnable(){
    boolean on=true;
    public void run(){
     if(overlay!=alertOverlay)return; // ya se reemplazó/quitó — no seguir parpadeando algo que no se ve
     overlay.setBackgroundColor(on?solid:dim);on=!on;
     ui.postDelayed(this,600);
    }
   };
   ui.postDelayed(alertBlinkRunnable,600);
  }else{
   boolean warning="warning".equals(level);
   LinearLayout bar=new LinearLayout(this);bar.setOrientation(LinearLayout.HORIZONTAL);bar.setGravity(Gravity.CENTER);
   bar.setBackgroundColor(warning?Color.rgb(240,180,41):Color.rgb(47,123,246));
   bar.setPadding(24,16,24,16);
   TextView t=new TextView(this);t.setText((warning?"⚠️ ":"ℹ️ ")+text);t.setTextColor(warning?Color.BLACK:Color.WHITE);t.setTextSize(14);t.setTypeface(null,android.graphics.Typeface.BOLD);t.setGravity(Gravity.CENTER);
   bar.addView(t);
   FrameLayout.LayoutParams lp=new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.TOP);
   overlay.addView(bar,lp);
  }
  return overlay;
 }
 // Agrega/reconstruye/quita el overlay del mix según el manifiesto actual.
 // Se llama desde layoutDisplay(), que ya corre en cada creación de canvas
 // y en cada actualización de manifiesto (la versión cambia si el mix
 // cambió), así queda sincronizado solo. Se reconstruye completo cada vez
 // (igual que el resto de la app, que re-renderiza todo ante cualquier
 // cambio) en vez de tratar de diffear — es sencillo y aquí no se llama
 // seguido como para que el costo importe.
 // "lastMixJson" evita reconstruir/re-aparecer el overlay cuando
 // layoutDisplay() se llama de nuevo SIN que el mix haya cambiado (cambió
 // el tamaño del video, giró la pantalla, etc.) — solo se actúa cuando el
 // contenido de verdad es distinto al que ya se aplicó. El fundido
 // (fadeMs, "el efecto de la palanca") se hace con un animate() de alpha
 // real sobre la vista, no un simple show/hide — así SÍ se ve un fundido
 // en la pantalla física, igual de real que el resto de esta función.
 private void syncMixOverlay(){
  JSONObject mix=current==null?null:current.optJSONObject("mix");
  String mixJson=mix==null?null:mix.toString();
  if(mix==null){
   if(!java.util.Objects.equals(mixJson,lastMixJson)){
    lastMixJson=mixJson;
    if(mixOverlay!=null){
     final FrameLayout old=mixOverlay;mixOverlay=null;
     old.animate().alpha(0f).setDuration(300).withEndAction(()->root.removeView(old)).start();
    }
   }
   return;
  }
  if(canvas==null)return; // nada que mostrar todavía — no se marca "visto", se reintenta en el próximo layoutDisplay()
  if(java.util.Objects.equals(mixJson,lastMixJson))return; // sin cambios reales desde la última vez
  lastMixJson=mixJson;
  if(mixOverlay!=null){root.removeView(mixOverlay);mixOverlay=null;}
  FrameLayout overlay=buildMixOverlay(mix);
  long fadeMs=mix.optLong("fadeMs",400);
  overlay.setAlpha(0f);
  root.addView(overlay,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
  overlay.animate().alpha(1f).setDuration(fadeMs).start();
  mixOverlay=overlay;
 }
 private int parseMixColor(String hex,int fallback){
  if(hex==null||hex.isEmpty())return fallback;
  try{return Color.parseColor(hex);}catch(Exception e){return fallback;}
 }
 // Espejo de mixOverlayHtml() en app.js (panel web) — mismos 4 layouts
 // (Franja/Esquina/Lateral/Corte) y mismos campos de estilo
 // (stripeColor/textColor/fontSize/thickness, con los mismos defaults que
 // styleOf() en server.js), para que se vea igual en la pantalla real que
 // en la vista previa del panel.
 private FrameLayout buildMixOverlay(JSONObject mix){
  String layout=mix.optString("layout","lower");
  String promoUrl=mix.optString("promoUrl","");
  String logoUrl=mix.optString("logoUrl","");
  String text=mix.optString("text","");
  boolean muted=mix.optBoolean("muted",false);
  int stripeColor=parseMixColor(mix.optString("stripeColor",""),Color.rgb(17,17,17));
  int textColor=parseMixColor(mix.optString("textColor",""),Color.WHITE);
  float fontSize=(float)mix.optDouble("fontSize",16);
  int thickness=mix.optInt("thickness",64);
  FrameLayout overlay=new FrameLayout(this);
  if("full".equals(layout))buildMixFull(overlay,promoUrl,logoUrl,text,stripeColor,textColor,fontSize);
  else if("split".equals(layout))buildMixSplit(overlay,promoUrl,logoUrl,text,stripeColor,textColor,fontSize);
  else if("corner".equals(layout))buildMixCorner(overlay,promoUrl,logoUrl,text,stripeColor,textColor,fontSize);
  else buildMixLower(overlay,logoUrl,text,stripeColor,textColor,fontSize,thickness);
  if(muted){
   TextView badge=new TextView(this);badge.setText("🔇 MUDO");badge.setTextColor(Color.rgb(196,201,207));badge.setTextSize(9);badge.setTypeface(null,android.graphics.Typeface.BOLD);
   badge.setBackgroundColor(Color.argb(204,14,15,18));badge.setPadding(7,3,7,3);
   FrameLayout.LayoutParams lp=new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.TOP|Gravity.END);lp.setMargins(0,8,8,0);
   overlay.addView(badge,lp);
  }
  return overlay;
 }
 private void buildMixFull(FrameLayout overlay,String promoUrl,String logoUrl,String text,int stripeColor,int textColor,float fontSize){
  overlay.setBackgroundColor(stripeColor);
  if(!promoUrl.isEmpty()){ImageView bg=mixImage(promoUrl,ImageView.ScaleType.CENTER_CROP);bg.setAlpha(0.55f);overlay.addView(bg,new FrameLayout.LayoutParams(-1,-1));}
  LinearLayout column=new LinearLayout(this);column.setOrientation(LinearLayout.VERTICAL);column.setGravity(Gravity.CENTER_HORIZONTAL);
  if(!logoUrl.isEmpty()){ImageView logo=mixImage(logoUrl,ImageView.ScaleType.FIT_CENTER);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,44);lp.bottomMargin=8;column.addView(logo,lp);}
  if(!text.isEmpty()){TextView t=new TextView(this);t.setText(text);t.setTextColor(textColor);t.setTextSize(fontSize);t.setTypeface(null,android.graphics.Typeface.BOLD);t.setGravity(Gravity.CENTER);t.setShadowLayer(4,0,1,Color.argb(180,0,0,0));column.addView(t);}
  FrameLayout.LayoutParams clp=new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.CENTER);clp.leftMargin=clp.rightMargin=16;
  overlay.addView(column,clp);
 }
 private void buildMixSplit(FrameLayout overlay,String promoUrl,String logoUrl,String text,int stripeColor,int textColor,float fontSize){
  LinearLayout row=new LinearLayout(this);row.setOrientation(LinearLayout.HORIZONTAL);
  overlay.addView(row,new FrameLayout.LayoutParams(-1,-1));
  row.addView(new View(this),new LinearLayout.LayoutParams(0,-1,62f)); // 62% izquierda, transparente: se ve la señal de abajo
  FrameLayout panel=new FrameLayout(this);panel.setBackgroundColor(stripeColor);
  row.addView(panel,new LinearLayout.LayoutParams(0,-1,38f)); // 38% derecha, el panel del mix
  if(!promoUrl.isEmpty()){ImageView bg=mixImage(promoUrl,ImageView.ScaleType.CENTER_CROP);bg.setAlpha(0.5f);panel.addView(bg,new FrameLayout.LayoutParams(-1,-1));}
  LinearLayout column=new LinearLayout(this);column.setOrientation(LinearLayout.VERTICAL);column.setGravity(Gravity.CENTER_HORIZONTAL);
  if(!logoUrl.isEmpty()){ImageView logo=mixImage(logoUrl,ImageView.ScaleType.FIT_CENTER);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,30);lp.bottomMargin=6;column.addView(logo,lp);}
  if(!text.isEmpty()){TextView t=new TextView(this);t.setText(text);t.setTextColor(textColor);t.setTextSize(fontSize*.7f);t.setTypeface(null,android.graphics.Typeface.BOLD);t.setGravity(Gravity.CENTER);t.setShadowLayer(3,0,1,Color.argb(180,0,0,0));column.addView(t);}
  FrameLayout.LayoutParams clp=new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.CENTER);clp.leftMargin=clp.rightMargin=8;
  panel.addView(column,clp);
 }
 // "Esquina" — el 4to formato del mockup, un logo/texto chico anclado a
 // una esquina, como el "bug" de un canal de TV. Nunca existió antes de
 // este micro-editor, ni siquiera en el preview del panel.
 private void buildMixCorner(FrameLayout overlay,String promoUrl,String logoUrl,String text,int stripeColor,int textColor,float fontSize){
  FrameLayout box=new FrameLayout(this);
  android.graphics.drawable.GradientDrawable shape=new android.graphics.drawable.GradientDrawable();shape.setColor(stripeColor);shape.setCornerRadius(14);
  box.setBackground(shape);box.setClipToOutline(true);
  if(!promoUrl.isEmpty()){ImageView bg=mixImage(promoUrl,ImageView.ScaleType.CENTER_CROP);bg.setAlpha(0.3f);box.addView(bg,new FrameLayout.LayoutParams(-1,-1));}
  LinearLayout column=new LinearLayout(this);column.setOrientation(LinearLayout.VERTICAL);column.setGravity(Gravity.CENTER_HORIZONTAL);column.setPadding(14,10,14,10);
  if(!logoUrl.isEmpty()){ImageView logo=mixImage(logoUrl,ImageView.ScaleType.FIT_CENTER);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,28);lp.bottomMargin=4;column.addView(logo,lp);}
  if(!text.isEmpty()){TextView t=new TextView(this);t.setText(text);t.setTextColor(textColor);t.setTextSize(fontSize*.65f);t.setTypeface(null,android.graphics.Typeface.BOLD);t.setGravity(Gravity.CENTER);t.setSingleLine(true);t.setEllipsize(android.text.TextUtils.TruncateAt.END);t.setMaxWidth(220);column.addView(t);}
  box.addView(column,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,FrameLayout.LayoutParams.WRAP_CONTENT));
  FrameLayout.LayoutParams boxLp=new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.BOTTOM|Gravity.END);boxLp.setMargins(0,0,20,20);
  overlay.addView(box,boxLp);
 }
 // "thickness" es la altura de la franja completa y también escala el
 // logo con ella — coincide con mixOverlayHtml() en app.js.
 private void buildMixLower(FrameLayout overlay,String logoUrl,String text,int stripeColor,int textColor,float fontSize,int thickness){
  LinearLayout bar=new LinearLayout(this);bar.setOrientation(LinearLayout.HORIZONTAL);bar.setGravity(Gravity.CENTER_VERTICAL);
  int transparent=Color.argb(0,Color.red(stripeColor),Color.green(stripeColor),Color.blue(stripeColor));
  int opaque=Color.argb(217,Color.red(stripeColor),Color.green(stripeColor),Color.blue(stripeColor));
  android.graphics.drawable.GradientDrawable gradient=new android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.BOTTOM_TOP,new int[]{opaque,transparent});
  bar.setBackground(gradient);bar.setPadding(12,10,12,8);bar.setMinimumHeight(thickness);
  int logoSize=Math.round(thickness*0.34f);
  if(!logoUrl.isEmpty()){ImageView logo=mixImage(logoUrl,ImageView.ScaleType.CENTER_CROP);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(logoSize,logoSize);lp.rightMargin=8;bar.addView(logo,lp);}
  if(!text.isEmpty()){TextView t=new TextView(this);t.setText(text);t.setTextColor(textColor);t.setTextSize(fontSize);t.setTypeface(null,android.graphics.Typeface.BOLD);t.setSingleLine(true);t.setEllipsize(android.text.TextUtils.TruncateAt.END);bar.addView(t,new LinearLayout.LayoutParams(0,LinearLayout.LayoutParams.WRAP_CONTENT,1f));}
  FrameLayout.LayoutParams blp=new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.BOTTOM);
  overlay.addView(bar,blp);
 }
 private ImageView mixImage(String url,ImageView.ScaleType scaleType){
  ImageView v=new ImageView(this);v.setScaleType(scaleType);
  loadMixImage(url,bmp->{if(bmp!=null&&v.isAttachedToWindow())v.setImageBitmap(bmp);});
  return v;
 }
 private void loadMixImage(String url,java.util.function.Consumer<Bitmap> callback){
  if(url==null||url.isEmpty())return;
  Bitmap cached=mixImageCache.get(url);
  if(cached!=null){callback.accept(cached);return;}
  network.execute(()->{
   try{
    HttpURLConnection c=connection(url,"GET");
    try{
     if(c.getResponseCode()!=200)throw new IOException("No se pudo cargar imagen del mix");
     Bitmap bitmap;try(InputStream in=c.getInputStream()){bitmap=BitmapFactory.decodeStream(in);}
     if(bitmap!=null){mixImageCache.put(url,bitmap);ui.post(()->callback.accept(bitmap));}
    }finally{c.disconnect();}
   }catch(Exception ignored){}
  });
 }
 private void message(String text){root.removeAllViews();TextView t=new TextView(this);t.setText(text);t.setTextColor(Color.rgb(177,237,137));t.setTextSize(24);t.setGravity(Gravity.CENTER);t.setPadding(24,24,24,24);root.addView(t,new FrameLayout.LayoutParams(-1,-1));}
 private void showPair(Bitmap qr,String code){if(current!=null)return;root.removeAllViews();LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setGravity(Gravity.CENTER);root.addView(box,new FrameLayout.LayoutParams(-1,-1));TextView title=new TextView(this);title.setText("VenuePro Signage\nEscanea desde el administrador");title.setTextSize(22);title.setGravity(Gravity.CENTER);title.setTextColor(Color.WHITE);box.addView(title);ImageView image=new ImageView(this);image.setImageBitmap(qr);int size=Math.min(getResources().getDisplayMetrics().widthPixels,getResources().getDisplayMetrics().heightPixels)/2;LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(size,size);lp.setMargins(0,18,0,18);box.addView(image,lp);TextView label=new TextView(this);label.setText(code+"\nCódigo válido por 10 minutos");label.setTextSize(20);label.setGravity(Gravity.CENTER);label.setTextColor(Color.rgb(177,237,137));box.addView(label);Button setup=new Button(this);setup.setText("Configurar inicio automático");setup.setOnClickListener(v->startupSettings());box.addView(setup);}
 private void startupSettings(){
  new AlertDialog.Builder(this).setTitle("Inicio automático")
   .setMessage("Para una pantalla dedicada, selecciona VenuePro Signage como aplicación de inicio predeterminada. Al encender y desbloquear Android, volverá al reproductor. Puedes cambiarlo después en Ajustes → Aplicaciones → Aplicaciones predeterminadas → Inicio. Algunos fabricantes no permiten cambiar el inicio.")
   .setPositiveButton("Elegir app de inicio",(dialog,which)->{try{startActivity(new Intent(Settings.ACTION_HOME_SETTINGS));}catch(RuntimeException error){Toast.makeText(this,"Configura la aplicación de inicio desde los ajustes del equipo",Toast.LENGTH_LONG).show();}})
   .setNegativeButton("Volver",null).show();
 }
 @Override public boolean onKeyUp(int keyCode,KeyEvent event){if(keyCode==KeyEvent.KEYCODE_MENU){startupSettings();return true;}return super.onKeyUp(keyCode,event);}
 @Override public void onPause(){super.onPause();paused=true;stopPlayback();}
 @Override public void onResume(){super.onResume();paused=false;if(!liveSource.isEmpty())playLive(liveSource);else if(current!=null)playNext();else {String saved=getPreferences(0).getString("pairQr","");if(!saved.isEmpty()){try{byte[] bytes=Base64.decode(saved,Base64.DEFAULT);showPair(BitmapFactory.decodeByteArray(bytes,0,bytes.length),getPreferences(0).getString("pairCode",""));}catch(Exception ignored){message("Conectando…");}}else message("Conectando…");}}
 @Override public void onDestroy(){destroyed=true;network.shutdownNow();ui.removeCallbacksAndMessages(null);stopPlayback();super.onDestroy();}
}
