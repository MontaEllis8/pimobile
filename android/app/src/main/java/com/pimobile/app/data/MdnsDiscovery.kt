package com.pimobile.app.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * mDNS discovery for Pi Mobile server via NsdManager.
 * Discovers `_pimobile._tcp` services published by the Node server's bonjour-service.
 */
data class DiscoveredService(
    val name: String,
    val host: String,
    val port: Int
)

class MdnsDiscovery(private val context: Context) {

    companion object {
        private const val TAG = "MdnsDiscovery"
        private const val SERVICE_TYPE = "_pimobile._tcp"
        private const val DISCOVERY_TIMEOUT_MS = 10_000L
    }

    private val nsdManager: NsdManager? =
        context.getSystemService(Context.NSD_SERVICE) as? NsdManager

    private val _services = MutableStateFlow<List<DiscoveredService>>(emptyList())
    val services: StateFlow<List<DiscoveredService>> = _services.asStateFlow()

    private val _isDiscovering = MutableStateFlow(false)
    val isDiscovering: StateFlow<Boolean> = _isDiscovering.asStateFlow()

    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var timeoutJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun startDiscovery() {
        if (nsdManager == null) {
            Log.w(TAG, "NsdManager unavailable")
            return
        }
        if (_isDiscovering.value) {
            Log.d(TAG, "Already discovering, ignore start")
            return
        }

        _services.value = emptyList()
        _isDiscovering.value = true

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
                Log.d(TAG, "Discovery started: $regType")
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                Log.d(TAG, "Service found: ${service.serviceName} / ${service.serviceType}")
                // Only resolve our type
                if (!service.serviceType.contains("pimobile")) return
                resolveService(service)
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                Log.d(TAG, "Service lost: ${service.serviceName}")
                _services.value = _services.value.filterNot { it.name == service.serviceName }
            }

            override fun onDiscoveryStopped(serviceType: String) {
                Log.d(TAG, "Discovery stopped: $serviceType")
                _isDiscovering.value = false
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Start discovery failed: $serviceType error=$errorCode")
                _isDiscovering.value = false
                try {
                    nsdManager.stopServiceDiscovery(this)
                } catch (_: Exception) {}
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Stop discovery failed: $serviceType error=$errorCode")
                _isDiscovering.value = false
            }
        }

        discoveryListener = listener
        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: Exception) {
            Log.e(TAG, "discoverServices threw", e)
            _isDiscovering.value = false
            return
        }

        // Auto-stop after 10s
        timeoutJob?.cancel()
        timeoutJob = scope.launch {
            delay(DISCOVERY_TIMEOUT_MS)
            Log.d(TAG, "Discovery timeout 10s, stopping")
            stopDiscovery()
        }
    }

    fun stopDiscovery() {
        timeoutJob?.cancel()
        timeoutJob = null
        val listener = discoveryListener ?: run {
            _isDiscovering.value = false
            return
        }
        discoveryListener = null
        try {
            nsdManager?.stopServiceDiscovery(listener)
        } catch (e: Exception) {
            Log.w(TAG, "stopServiceDiscovery failed", e)
            _isDiscovering.value = false
        }
        // onDiscoveryStopped will set false; set false as fallback if callback not fired
        _isDiscovering.value = false
    }

    private fun resolveService(service: NsdServiceInfo) {
        if (nsdManager == null) return
        try {
            nsdManager.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    Log.w(TAG, "Resolve failed ${serviceInfo.serviceName} error=$errorCode")
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val host = serviceInfo.host?.hostAddress
                        ?: serviceInfo.hostAddresses.firstOrNull()?.hostAddress
                        ?: ""
                    if (host.isBlank()) {
                        Log.w(TAG, "Resolved host blank for ${serviceInfo.serviceName}")
                        return
                    }
                    val port = serviceInfo.port
                    val name = serviceInfo.serviceName
                    Log.d(TAG, "Resolved $name -> $host:$port")
                    val discovered = DiscoveredService(name = name, host = host, port = port)
                    val current = _services.value
                    if (current.none { it.host == host && it.port == port }) {
                        _services.value = current + discovered
                    }
                }
            })
        } catch (e: Exception) {
            Log.w(TAG, "resolveService threw", e)
        }
    }
}
