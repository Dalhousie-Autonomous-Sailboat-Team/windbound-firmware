/*
 * Host runtime for the windbound_sil shared library, which the Python
 * simulator in sim/ loads to run the real firmware logic.
 *
 * It replaces the RTOS calls the shared-state module makes, so the simulator
 * owns the clock: osKernelGetTickCount() returns whatever Sil_SetTickCount()
 * last set. app_state.c is compiled into this file so Sil_Reset() can clear
 * its private state between simulations without changing the firmware module.
 */

#include <stdint.h>
#include <string.h>

#include "cmsis_os2.h"
#include "control_logic.h"

#include "app_state.c"

osMutexId_t windMutexHandle = (osMutexId_t)(uintptr_t)1U;
osMutexId_t xbeeMutexHandle = (osMutexId_t)(uintptr_t)2U;
osMutexId_t rpiMutexHandle = (osMutexId_t)(uintptr_t)3U;

static uint32_t sil_tick_ms;

osStatus_t osMutexAcquire(osMutexId_t mutex_id, uint32_t timeout)
{
    (void)mutex_id;
    (void)timeout;
    return osOK;
}

osStatus_t osMutexRelease(osMutexId_t mutex_id)
{
    (void)mutex_id;
    return osOK;
}

uint32_t osKernelGetTickCount(void)
{
    return sil_tick_ms;
}

void Sil_SetTickCount(uint32_t now_ms)
{
    sil_tick_ms = now_ms;
}

void Sil_Reset(void)
{
    sil_tick_ms = 0U;
    memset(&wind_latest, 0, sizeof(wind_latest));
    memset(&xbee_latest, 0, sizeof(xbee_latest));
    memset(&rpi_latest, 0, sizeof(rpi_latest));
}

/* Lets the Python bindings check their struct layouts against this build. */
uint32_t Sil_StructSize(const char *name)
{
    static const struct
    {
        const char *name;
        uint32_t size;
    } sizes[] = {
        {"WindSample_t", sizeof(WindSample_t)},
        {"XbeeCommand_t", sizeof(XbeeCommand_t)},
        {"RPiSample_t", sizeof(RPiSample_t)},
        {"EncoderSample_t", sizeof(EncoderSample_t)},
        {"ControlLogicInput_t", sizeof(ControlLogicInput_t)},
        {"ControlLogicOutput_t", sizeof(ControlLogicOutput_t)},
    };

    if (name == NULL)
        return 0U;

    for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++)
    {
        if (strcmp(sizes[i].name, name) == 0)
            return sizes[i].size;
    }
    return 0U;
}
