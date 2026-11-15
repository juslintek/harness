package dev.harness.mobile.core.network

import okhttp3.Interceptor
import okhttp3.Response
import java.util.concurrent.CountDownLatch

class SingleFlightStepUpCoordinator(
    private val stepUpAction: () -> Boolean
) {
    private val lock = Any()
    private var activeLatch: CountDownLatch? = null
    private var lastResult = false

    fun executeStepUp(): Boolean {
        var isLeader = false
        var latch: CountDownLatch

        synchronized(lock) {
            val current = activeLatch
            if (current != null) {
                latch = current
            } else {
                val newLatch = CountDownLatch(1)
                activeLatch = newLatch
                latch = newLatch
                isLeader = true
            }
        }

        if (isLeader) {
            val success = try {
                stepUpAction()
            } catch (_: Exception) {
                false
            }
            synchronized(lock) {
                lastResult = success
                activeLatch = null
            }
            latch.countDown()
            return success
        } else {
            latch.await()
            return synchronized(lock) { lastResult }
        }
    }
}

class StepUpInterceptor(
    private val coordinator: SingleFlightStepUpCoordinator
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)

        if (response.code == 403) {
            val peek = response.peekBody(4096).string()
            if (peek.contains("step_up_required") || peek.contains("step_up")) {
                response.close()
                val ok = coordinator.executeStepUp()
                if (ok) {
                    return chain.proceed(request)
                }
            }
        }
        return response
    }
}
