package com.pedivoy.clientes

import android.annotation.SuppressLint
import androidx.activity.result.contract.ActivityResultContracts
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.MenuItem
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.pedivoy.clientes.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val baseUrl by lazy { getString(R.string.base_url) }
    private val allowedHost by lazy { Uri.parse(baseUrl).host ?: "pedivoy.com" }
    private var lastConfirmedOrderId: String? = null
    private var currentOrderUrl: String? = null
    private var currentOrderPhone: String? = null
    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val files = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        fileChooserCallback?.onReceiveValue(files)
        fileChooserCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        configureToolbar()
        configureWebView()
        configureRefresh()
        configureBackNavigation()
        configureOrderConfirmation()
        maybeRequestNotifications()

        if (savedInstanceState == null) {
            binding.webView.loadUrl(baseUrl)
        } else {
            binding.webView.restoreState(savedInstanceState)
        }
    }

    private fun configureToolbar() {
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> {
                    binding.webView.reload()
                    true
                }
                2 -> {
                    openExternal(baseUrl)
                    true
                }
                else -> false
            }
        }
        binding.toolbar.menu.add(0, 1, 0, getString(R.string.reload)).apply {
            setIcon(R.drawable.ic_action_refresh)
            setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        }
        binding.toolbar.menu.add(0, 2, 1, getString(R.string.open_in_browser)).apply {
            setIcon(R.drawable.ic_action_open)
            setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        }
        binding.statusBar.text = getString(R.string.status_secure)
    }

    private fun configureOrderConfirmation() {
        binding.viewOrderButton.setOnClickListener {
            currentOrderUrl?.let { binding.webView.loadUrl(it) }
            hideOrderConfirmation()
        }
        binding.whatsAppButton.setOnClickListener {
            currentOrderPhone?.takeIf { it.isNotBlank() }?.let { phone ->
                openExternal("https://wa.me/$phone")
            }
        }
        binding.newOrderButton.setOnClickListener {
            hideOrderConfirmation()
            binding.webView.loadUrl(baseUrl)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(binding.webView, true)

        binding.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadsImagesAutomatically = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            useWideViewPort = true
            loadWithOverviewMode = true
            mediaPlaybackRequiresUserGesture = false
            builtInZoomControls = false
            displayZoomControls = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        binding.webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val target = request?.url ?: return false
                val scheme = target.scheme.orEmpty()
                val host = target.host.orEmpty()

                if (scheme in listOf("http", "https")) {
                    return if (host == allowedHost || host.endsWith(".$allowedHost")) {
                        false
                    } else {
                        openExternal(target.toString())
                        true
                    }
                }

                return when (scheme) {
                    "tel", "mailto", "whatsapp", "geo", "market" -> {
                        openExternal(target.toString())
                        true
                    }
                    else -> false
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                binding.swipeRefresh.isRefreshing = false
                handleOrderConfirmationUrl(url)
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.progressBar.progress = newProgress
                binding.progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                if (newProgress < 100) {
                    binding.statusBar.text = getString(R.string.loading_message)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                return try {
                    val chooserIntent = fileChooserParams?.createIntent()
                    if (chooserIntent == null) {
                        fileChooserCallback = null
                        false
                    } else {
                        fileChooserLauncher.launch(chooserIntent)
                        true
                    }
                } catch (_: ActivityNotFoundException) {
                    fileChooserCallback = null
                    false
                }
            }
        }
    }

    private fun handleOrderConfirmationUrl(url: String?) {
        val uri = url?.let(Uri::parse)
        if (uri != null && isOrderConfirmationPage(uri)) {
            val orderId = uri.getQueryParameter("id")?.takeIf { it.isNotBlank() }
            if (orderId != null) {
                currentOrderUrl = uri.toString()
                currentOrderPhone = uri.getQueryParameter("telefono")
                binding.orderNumberText.text = getString(R.string.order_number_label, orderId)
                binding.orderPhoneText.text = currentOrderPhone
                    ?.takeIf { it.isNotBlank() }
                    ?.let { getString(R.string.order_phone_label, it) }
                    ?: ""
                binding.orderPhoneText.visibility = if (currentOrderPhone.isNullOrBlank()) View.GONE else View.VISIBLE
                binding.orderConfirmationCard.visibility = View.VISIBLE
                binding.statusBar.text = getString(R.string.status_order_sent)
                if (lastConfirmedOrderId != orderId) {
                    lastConfirmedOrderId = orderId
                }
                return
            }
        }
        hideOrderConfirmation()
        binding.statusBar.text = getString(R.string.ready_message)
    }

    private fun isOrderConfirmationPage(uri: Uri): Boolean {
        val path = uri.path.orEmpty()
        return path.endsWith("/pedidos/pedido.html") || path.endsWith("pedido.html")
    }

    private fun hideOrderConfirmation() {
        binding.orderConfirmationCard.visibility = View.GONE
    }

    private fun configureRefresh() {
        binding.swipeRefresh.setColorSchemeColors(
            ContextCompat.getColor(this, R.color.pedivoy_primary),
            ContextCompat.getColor(this, R.color.pedivoy_accent),
            ContextCompat.getColor(this, R.color.pedivoy_primary_soft)
        )
        binding.swipeRefresh.setProgressBackgroundColorSchemeColor(
            ContextCompat.getColor(this, R.color.pedivoy_surface_elevated)
        )
        binding.swipeRefresh.setOnRefreshListener {
            if (binding.webView.url.isNullOrBlank()) binding.webView.loadUrl(baseUrl)
            else binding.webView.reload()
        }
    }

    private fun configureBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.orderConfirmationCard.visibility == View.VISIBLE) {
                    hideOrderConfirmation()
                } else if (binding.webView.canGoBack()) {
                    binding.webView.goBack()
                } else {
                    finish()
                }
            }
        })
    }

    private fun maybeRequestNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        }
    }

    private fun openExternal(url: String) {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }.onFailure {
            binding.statusBar.text = getString(R.string.offline_message)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webView.saveState(outState)
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        binding.webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 1102
    }
}
