/**
 * @file telemetry.c
 * @brief Assembles sensor data and transmits JSON telemetry over XBee.
 */

#include "L3/telemetry.h"
#include "L2/encoder.h"
#include "L2/app_types.h"
#include "L1/user_uart.h"
#include "cmsis_os.h"

#include <stdio.h>
#include <string.h>

#define TELEMETRY_PERIOD_MS 1000U
#define TELEMETRY_BUF_LEN 256U

extern osMessageQueueId_t wind_queueHandle;
extern osMessageQueueId_t rpi_queueHandle;

void TelemetryTask(void *argument)
{
    (void)argument;

    /* Local shadow of latest data — updated whenever a queue delivers */
    WindSample_t wind = {0};
    RPiSample_t rpi = {0};
    EncoderSample_t enc = {0};

    while (true)
    {
        /* ── 1. Drain queues — take latest, don't block ─────────── */
        osMessageQueueGet(wind_queueHandle, &wind, NULL, 0);
        osMessageQueueGet(rpi_queueHandle, &rpi, NULL, 0);

        /* ── 2. Grab latest encoder angle under mutex ────────────── */
        Encoder_GetLatest(&enc);

        /* ── 3. Format and transmit ──────────────────────────────── */
        char buf[TELEMETRY_BUF_LEN];
        snprintf(buf, sizeof(buf),
                 "{wd:%.1f,ws:%.1f,ws_unit:%c,ws_ref:%c,"
                 "angle:%.2f,"
                 "tb:%.1f,wlat:%.6f,wlon:%.6f,tsa:%.1f,tra:%.1f,"
                 "clat:%.6f,clon:%.6f,"
                 "pitch:%.2f,roll:%.2f,yaw:%.2f}\r\n",
                 wind.direction, wind.speed,
                 wind.speed_unit,
                 wind.reference,
                 enc.angle,
                 rpi.target_bearing, rpi.waypoint_lat, rpi.waypoint_lon,
                 rpi.target_sail_angle, rpi.target_rudder_angle,
                 rpi.current_lat, rpi.current_lon,
                 rpi.pitch, rpi.roll, rpi.yaw);

        // UserUART_Transmit(UART_PORT_XBEE, (uint8_t *)buf, strlen(buf));
        Radio_Print_String(buf);
        /* ── 4. Fixed period ─────────────────────────────────────── */
        osDelay(TELEMETRY_PERIOD_MS);
    }
}