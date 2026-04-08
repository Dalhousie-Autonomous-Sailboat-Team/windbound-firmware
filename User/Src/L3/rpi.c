#include "L3/rpi.h"
#include "cmsis_os.h"
#include "L1/user_uart.h"
#include "L2/app_types.h"

#include <stdio.h>
#include <string.h>


extern osMessageQueueId_t wind_queueHandle; 
static char tx_buf[128];

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
        //RPi_Print_String(tx_buf);

        Debug_Print_String(tx_buf);
      
    }
}

