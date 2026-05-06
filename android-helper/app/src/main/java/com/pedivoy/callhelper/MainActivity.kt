package com.pedivoy.callhelper

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.telecom.TelecomManager
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var statusText: TextView
    private lateinit var dialerStatusText: TextView
    private lateinit var requestDialerButton: Button

    private val requestPermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val granted = permissions.all { it.value }
        statusText.text = if (granted) {
            "Permisos concedidos. Helper listo para llamadas."
        } else {
            "Faltan permisos. Sin CALL_PHONE no podrá llamar automáticamente."
        }
        updateStatus()
    }

    private val requestDialerRole = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        updateStatus()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        dialerStatusText = findViewById(R.id.dialerStatusText)
        requestDialerButton = findViewById(R.id.requestDialerButton)

        requestDialerButton.setOnClickListener {
            requestDefaultDialerRole()
        }

        updateStatus()
        requestMissingPermissions()
    }

    private fun updateStatus() {
        val callGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
        statusText.text = if (callGranted) {
            "Helper listo. CALL_PHONE concedido."
        } else {
            "Helper instalado. Falta otorgar CALL_PHONE."
        }

        val isDefaultDialer = isDefaultDialer()
        dialerStatusText.text = if (isDefaultDialer) {
            "App de teléfono predeterminada: SÍ"
        } else {
            "App de teléfono predeterminada: NO"
        }
        requestDialerButton.isEnabled = !isDefaultDialer
    }

    private fun requestMissingPermissions() {
        val permissions = mutableListOf(Manifest.permission.CALL_PHONE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }

        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isNotEmpty()) {
            requestPermissions.launch(missing.toTypedArray())
        }
    }

    private fun isDefaultDialer(): Boolean {
        val telecomManager = getSystemService(TelecomManager::class.java)
        return telecomManager?.defaultDialerPackage == packageName
    }

    private fun requestDefaultDialerRole() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java)
            if (roleManager != null && roleManager.isRoleAvailable(RoleManager.ROLE_DIALER) && !roleManager.isRoleHeld(RoleManager.ROLE_DIALER)) {
                requestDialerRole.launch(roleManager.createRequestRoleIntent(RoleManager.ROLE_DIALER))
                return
            }
        }

        val intent = Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER).apply {
            putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, packageName)
        }
        requestDialerRole.launch(intent)
    }
}
