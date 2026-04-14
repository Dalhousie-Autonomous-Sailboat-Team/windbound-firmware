#include "L2/rpi.h"
#include "cmsis_os.h"
#include "L1/user_uart.h"
#include "L2/app_types.h"

#include <stdio.h>
#include <string.h>


extern osMessageQueueId_t wind_queueHandle; 
extern osMutexId_t rpiMutexHandle;

static char tx_buf[128];
static RPiSample_t rpi_latest;

void RpiTransmitTask(void *argument)
{
    WindSample_t sample;
   
    while (true)
    {
        // block until a wind sample arrives
        if (osMessageQueueGet(wind_queueHandle, &sample, NULL, osWaitForever) != osOK)
            continue;

        // format as JSON
        snprintf(tx_buf, sizeof(tx_buf),
                 "{\"SensorInput\":[{\"windAngle\":%d}]}\r\n",
                 (int)sample.direction);

        // send to RPi
        RPi_Print_String(tx_buf);

        //Debug_Print_String(tx_buf);
      
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





