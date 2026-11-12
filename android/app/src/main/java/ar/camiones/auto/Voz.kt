package ar.camiones.auto

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/** Voz de las indicaciones: baja el volumen de la radio mientras habla (como los navegadores). */
class Voz(ctx: Context) : TextToSpeech.OnInitListener {
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val foco = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
    private val tts = TextToSpeech(ctx.applicationContext, this)
    private var lista = false

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) return
        val ar = Locale.forLanguageTag("es-AR")
        if (tts.setLanguage(ar) < TextToSpeech.LANG_AVAILABLE) tts.setLanguage(Locale.forLanguageTag("es"))
        tts.setAudioAttributes(attrs)
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { audio.abandonAudioFocusRequest(foco) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { audio.abandonAudioFocusRequest(foco) }
        })
        lista = true
    }

    fun decir(texto: String) {
        if (!lista || texto.isBlank()) return
        audio.requestAudioFocus(foco)
        tts.speak(texto, TextToSpeech.QUEUE_ADD, null, "camionesar-" + System.nanoTime())
    }

    fun cerrar() {
        runCatching { tts.stop(); tts.shutdown() }
        audio.abandonAudioFocusRequest(foco)
    }
}
