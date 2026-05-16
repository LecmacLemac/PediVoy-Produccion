package com.pedivoy.callhelper

import android.telecom.InCallService
import android.util.Log

class PediVoyInCallService : InCallService() {
    override fun onCallAdded(call: android.telecom.Call) {
        super.onCallAdded(call)
        Log.i("PediVoyInCallService", "Call added to InCallService")
    }

    override fun onCallRemoved(call: android.telecom.Call) {
        super.onCallRemoved(call)
        Log.i("PediVoyInCallService", "Call removed from InCallService")
    }
}
