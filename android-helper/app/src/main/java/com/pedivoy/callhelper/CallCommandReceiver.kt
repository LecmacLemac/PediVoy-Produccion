package com.pedivoy.callhelper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

class CallCommandReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_CALL) return

        val phone = intent.getStringExtra(EXTRA_PHONE)
        if (phone.isNullOrBlank()) {
            Log.e(TAG, "CALL command sin número")
            return
        }

        val callIntent = Intent(Intent.ACTION_CALL).apply {
            data = Uri.parse("tel:$phone")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        try {
            context.startActivity(callIntent)
            Log.i(TAG, "Llamada iniciada para $phone")
        } catch (error: SecurityException) {
            Log.e(TAG, "Falta permiso CALL_PHONE", error)
        } catch (error: Exception) {
            Log.e(TAG, "No se pudo iniciar llamada", error)
        }
    }

    companion object {
        const val ACTION_CALL = "com.pedivoy.callhelper.CALL"
        const val EXTRA_PHONE = "phone"
        private const val TAG = "PediVoyCallHelper"
    }
}
