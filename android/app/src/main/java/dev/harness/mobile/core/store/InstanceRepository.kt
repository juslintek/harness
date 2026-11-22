package dev.harness.mobile.core.store

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

@Serializable
data class InstanceConfig(
    val id: String,
    val name: String,
    val originUrl: String
)

class InstanceRepository(
    initialInstances: List<InstanceConfig> = listOf(
        InstanceConfig("default", "Local Instance", "http://127.0.0.1:4100")
    )
) {
    private val _instances = MutableStateFlow(initialInstances)
    val instances: StateFlow<List<InstanceConfig>> = _instances.asStateFlow()

    private val _activeInstance = MutableStateFlow(initialInstances.first())
    val activeInstance: StateFlow<InstanceConfig> = _activeInstance.asStateFlow()

    fun selectInstance(id: String) {
        val found = _instances.value.find { it.id == id } ?: return
        _activeInstance.value = found
    }

    fun addInstance(name: String, originUrl: String): InstanceConfig {
        val normalizedUrl = originUrl.trim().trimEnd('/')
        val newInstance = InstanceConfig(
            id = "inst_${System.currentTimeMillis()}",
            name = name.ifBlank { normalizedUrl },
            originUrl = normalizedUrl
        )
        _instances.value = _instances.value + newInstance
        _activeInstance.value = newInstance
        return newInstance
    }

    fun removeInstance(id: String) {
        val updated = _instances.value.filter { it.id != id }
        if (updated.isNotEmpty()) {
            _instances.value = updated
            if (_activeInstance.value.id == id) {
                _activeInstance.value = updated.first()
            }
        }
    }
}
