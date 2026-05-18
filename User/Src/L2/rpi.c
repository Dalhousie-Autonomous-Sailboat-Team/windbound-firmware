#include "L2/rpi.h"
#include "cmsis_os.h"
#include "L1/user_uart.h"
#include "L2/app_types.h"
#include "L3/boat_mode.h"
#include "L2/wind.h"

#include <stdio.h>
#include <string.h>


extern osMutexId_t rpiMutexHandle;

static char tx_buf[128];
static RPiSample_t rpi_latest;

void RpiTransmitTask(void *argument)
{
    WindSample_t sample = {0};

    while (true)
    {

        Wind_GetLatest(&sample);
        snprintf(tx_buf, sizeof(tx_buf),
                 "{\"SensorInput\":[{\"windAngle\":%d}]}\r\n",
                 (int)sample.direction);

        RPi_Print_String(tx_buf);
        osDelay(500);

    }
}

void RPi_UpdateLatest(const RPiSample_t *sample)
{
    if (sample == NULL || rpiMutexHandle == NULL)
        return;

    osMutexAcquire(rpiMutexHandle, osWaitForever);
    rpi_latest = *sample;
    osMutexRelease(rpiMutexHandle);
}

void RPi_GetLatest(RPiSample_t *out)
{
    if (out == NULL || rpiMutexHandle == NULL)
        return;

    osMutexAcquire(rpiMutexHandle, osWaitForever);
    *out = rpi_latest;
    osMutexRelease(rpiMutexHandle);
}
