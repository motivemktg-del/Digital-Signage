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
 private volatile String liveSource="",liveSourceRtsp="";
 private String livePlayingUrl="";
 @Override public void onCreate(Bundle b){super.onCreate(b);
  getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  root=new FrameLayout(this);root.setBackgroundColor(Color.BLACK);setContentView(root);root.setClipChildren(true);root.addOnLayoutChangeListener((v,l,t,r,bottom,ol,ot,or,ob)->{if(r-l!=or-ol||bottom-t!=ob-ot)layoutDisplay();});
  assets=new File(getFilesDir(),"media");assets.mkdirs();
  secret=getPreferences(0).getString("secret","");
  try{current=new JSONObject(new String(new AtomicFile(new File(getFilesDir(),"manifest.json")).readFully(),StandardCharsets.UTF_8));version=current.getString("version");liveSource=current.optString("liveSource","");liveSourceRtsp=current.optString("liveSourceRtsp","");}catch(Exception ignored){}
  if(!liveSource.isEmpty())playLive(liveSource);else if(current!=null)playNext();else{String saved=getPreferences(0).getString("pairQr","");if(!saved.isEmpty()){try{byte[] bytes=Base64.decode(saved,Base64.DEFAULT);showPair(BitmapFactory.decodeByteArray(bytes,0,bytes.length),getPreferences(0).getString("pairCode",""));}catch(Exception ignored){message("VenuePro Signage\nConectando tu pantalla…");}}else message("VenuePro Signage\nConectando tu pantalla…");}
  network.scheduleWithFixedDelay(this::sync,0,20,TimeUnit.SECONDS);
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
 private void sync(){
  if(destroyed)return;
  try{
   if(secret.isEmpty()){
    JSONObject pair=request("/api/pair/start",new JSONObject());secret=pair.getString("secret");getPreferences(0).edit().putString("secret",secret).apply();
    String code=pair.getString("code"),data=pair.getString("qr").split(",",2)[1];byte[] bytes=Base64.decode(data,Base64.DEFAULT);Bitmap qr=BitmapFactory.decodeByteArray(bytes,0,bytes.length);
    getPreferences(0).edit().putString("pairQr",data).putString("pairCode",code).apply();
    ui.post(()->showPair(qr,code));
   }
   JSONObject next=request("/api/player/manifest",null);
   if(!next.optBoolean("paired"))return;
   getPreferences(0).edit().remove("pairQr").remove("pairCode").apply();
   if(!next.getString("version").equals(version)){
    LinkedHashMap<String,JSONObject> all=new LinkedHashMap<>();collect(next.getJSONArray("items"),all);
    JSONArray schedules=next.optJSONArray("schedules");if(schedules!=null)for(int n=0;n<schedules.length();n++)collect(schedules.getJSONObject(n).getJSONArray("items"),all);
    for(JSONObject item:all.values())download(item);
    // Keep the previous manifest active until every asset verifies successfully.
    AtomicFile file=new AtomicFile(new File(getFilesDir(),"manifest.json"));FileOutputStream out=null;
    try{out=file.startWrite();out.write(next.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}catch(Exception e){if(out!=null)file.failWrite(out);throw e;}
    current=next;version=next.getString("version");lastError="";liveSource=next.optString("liveSource","");liveSourceRtsp=next.optString("liveSourceRtsp","");
    ui.post(()->{sequence="";layoutDisplay();
     if(!liveSource.isEmpty())playLive(liveSource);
     else if(next.optBoolean("paused"))stopPlayback();
     else if(!playing&&!paused)playNext();});
   }
   request("/api/player/heartbeat",new JSONObject().put("version",version).put("error",lastError));
  }catch(Unpaired e){
   secret="";version="";current=null;getPreferences(0).edit().remove("secret").remove("pairQr").remove("pairCode").apply();new AtomicFile(new File(getFilesDir(),"manifest.json")).delete();
   ui.post(()->{stopPlayback();message("Pantalla desvinculada\nGenerando un nuevo código…");});
  }catch(Exception e){lastError=e.getMessage()==null?"Error de sincronización":e.getMessage();if(current==null)ui.post(()->{if(!playing)message("No se pudo conectar\nSe intentará de nuevo automáticamente");});try{if(!secret.isEmpty())request("/api/player/heartbeat",new JSONObject().put("version",version).put("error",lastError));}catch(Exception ignored){}}
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
 private void stopPlayback(){ui.removeCallbacks(advance);if(mediaPlayer!=null){mediaPlayer.release();mediaPlayer=null;}if(exoPlayer!=null){exoPlayer.release();exoPlayer=null;}video=null;canvas=null;videoWidth=0;videoHeight=0;if(photo!=null){photo.setImageDrawable(null);photo=null;}livePlayingUrl="";playing=false;root.removeAllViews();}
 // Si el manifiesto trae liveSourceRtsp (go2rtc), se usa ESA — RTSP no
 // tiene el buffer de varios segundos del MP4 progresivo (el que usa el
 // proxy del panel web, pensado para navegadores que no pueden abrir
 // RTSP directo). Si no hay RTSP derivable (fuente en vivo genérica, no
 // go2rtc), cae al MediaPlayer+MP4 de siempre.
 private void playLive(String url){
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
 // ExoPlayer sobre RTSP-TCP (más confiable detrás de NAT/firewall que UDP,
 // el costo de latencia es mínimo) — esto sí es tiempo casi real.
 @androidx.media3.common.util.UnstableApi
 private void playLiveRtsp(String rtspUrl){
  if(destroyed||paused)return;
  if(rtspUrl.equals(livePlayingUrl))return; // ya está en esa URL
  stopPlayback();
  livePlayingUrl=rtspUrl;playing=true;
  canvas=new FrameLayout(this);canvas.setClipChildren(true);root.addView(canvas);layoutDisplay();
  video=new TextureView(this);canvas.addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
  final androidx.media3.exoplayer.ExoPlayer player=new androidx.media3.exoplayer.ExoPlayer.Builder(this).build();
  exoPlayer=player;
  player.setVideoTextureView(video);
  androidx.media3.exoplayer.source.MediaSource source=new androidx.media3.exoplayer.rtsp.RtspMediaSource.Factory()
   .setForceUseRtpTcp(true)
   .createMediaSource(androidx.media3.common.MediaItem.fromUri(rtspUrl));
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
   final androidx.media3.exoplayer.ExoPlayer player=new androidx.media3.exoplayer.ExoPlayer.Builder(this).build();
   exoPlayer=player;player.setVideoTextureView(video);
   androidx.media3.exoplayer.source.MediaSource source=new androidx.media3.exoplayer.rtsp.RtspMediaSource.Factory().setForceUseRtpTcp(true).createMediaSource(androidx.media3.common.MediaItem.fromUri(rtsp));
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
