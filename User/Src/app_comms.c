/**
 * @file app_comms.c
 *
 * @brief Application communication code for handling serial and JSON data parsing.
 */

/* Module Header */
#include "app_comms.h"

/* System Headers */
#include "main.h"
#include "cmsis_os2.h"

/* Standard Includes */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <stddef.h>

/* User Includes */
#include "board_io.h"
#include "command_dispatch.h"
#include "app_state.h"
#include "app_comms.h"
#include "app_protocol.h"
#include "encoder.h"

#ifdef RADIOMODE
#include "radio_api.h"
#endif


#define BACKSPACE_CHAR '\177'
#define NULL_CHAR '\0'
#define CARRIAGE_RETURN_CHAR '\r'

#define PARSE_STORAGE_LEN 32
#define NMEA_IIMWV "$IIMWV"
#define NMEA_IIMWV_LEN 6

#define TELEMETRY_PERIOD_MS 1000
#define TELEMETRY_BUF_LEN 256

extern osMessageQueueId_t uart_rx_queueHandle;

extern osMessageQueueId_t wind_queueHandle;

static char tx_buf[128];

static void ProcessWindvaneData(uint8_t data)
{
    /* We only want the $IIMWV NMEA sentence from the windvane */

    static char nmea_sentence[64];
    static uint8_t index = 0;
    static bool collecting = false;
    static uint8_t match_index = 0;

    if (data == '$')
    {
        index = 0;
        match_index = 0;
        collecting = true;
    }

    if (!collecting)
    {
        return;
    }

    // overflow protection
    if (index >= sizeof(nmea_sentence) - 1)
    {
        collecting = false;
        index = 0;
        return;
    }

    nmea_sentence[index++] = data;

    // check character match every ISR, else discard immediately
    if (match_index < NMEA_IIMWV_LEN)
    {
        if (data == NMEA_IIMWV[match_index])
            match_index++;
        else
            collecting = false;
    }

    if (data == '\n')
    {
        collecting = false;
        nmea_sentence[index] = NULL_CHAR;

        if (match_index == NMEA_IIMWV_LEN)
        {
            // We have a full $IIMWV sentence, send to windvane parser
            WindSample_t sample;
            if (AppProtocol_ParseWindNmea(nmea_sentence, &sample))
            {
                // osMessageQueuePut(wind_queueHandle, &sample, 0, 0);
                Wind_UpdateLatest(&sample);
                // Debug_Print("Parsed windvane data\r\n");
            }
        }

        index = 0;
    }
}

static char xbee_packet[64];
static uint8_t xbee_index;
static bool xbee_collecting;

static void ResetXbeeData(void)
{
    xbee_index = 0U;
    xbee_collecting = false;
}

static bool ProcessXbeeData(uint8_t data)
{
    // Start collecting on '{'
    if (data == '{')
    {
        xbee_index = 0U;
        xbee_collecting = true;
    }

    if (!xbee_collecting)
        return false;

    // Overflow protection
    if (xbee_index >= sizeof(xbee_packet) - 1U)
    {
        ResetXbeeData();
        return false;
    }

#ifdef RADIOMODE
    if (data == '\0') {
        ResetXbeeData();
        return false;
    }
#endif
    xbee_packet[xbee_index++] = (char)data;

    // End of packet on '\n'
    if (data == '\n')
    {
        xbee_packet[xbee_index] = '\0';
        ResetXbeeData();

        XbeeCommand_t cmd = {0};
        if (AppProtocol_ParseXbeeCommand(xbee_packet, &cmd))
        {
            Xbee_UpdateLatest(&cmd);
            return true;
        }
    }
    return false;
}

static void ProcessRaspberryData(uint8_t data)
{
    static char rpi_packet[256]; // also bumped size — your packet is ~120 chars
    static uint8_t index = 0;
    static bool collecting = false;
    static uint8_t brace_depth = 0;

    // Debug_Print((char[]){(char) data, '\0'});

    if (data == '{' && !collecting)
    {
        index = 0;
        brace_depth = 0;
        collecting = true;
    }

    if (!collecting)
        return;

    if (index >= sizeof(rpi_packet) - 1)
    {
        collecting = false;
        index = 0;
        brace_depth = 0;
        return;
    }

    rpi_packet[index++] = data;

    if (data == '{')
        brace_depth++;
    if (data == '}')
        brace_depth--;

    if (data == '}' && brace_depth == 0)
    {
        collecting = false;
        rpi_packet[index] = '\0';
        index = 0;

        RPiSample_t RPi_sample;
        Debug_Print("Got full string\r\n");

        if (AppProtocol_ParseRpiSample(rpi_packet, &RPi_sample))
        {
            RPi_UpdateLatest(&RPi_sample);
            Debug_Print("RPi data parsed and stored\r\n");
        }
    }
}

void UARTParserTask(void *argument)
{
    (void)argument;
    UART_Char_t uart_char;
#ifdef RADIOMODE
    /* Poll UART8 at least every 5 ms while other UARTs are quiet. */
    const uint32_t queue_wait = (osKernelGetTickFreq() + 199U) / 200U;
    RadioApi_Init(ProcessXbeeData, ResetXbeeData);
#else
    const uint32_t queue_wait = osWaitForever;
#endif
    BoardUART_Init();
    while (true)
    {
        if (osMessageQueueGet(uart_rx_queueHandle, &uart_char, NULL, queue_wait) == osOK) {
            switch (uart_char.port) {
            case UART_PORT_3:
                ProcessWindvaneData(uart_char.data);
                break;
            case UART_PORT_7:
                ProcessRaspberryData(uart_char.data);
                break;
#ifndef RADIOMODE
            case UART_PORT_8:
                ProcessXbeeData(uart_char.data);
                break;
#endif
            default:
                break;
            }
        }
#ifdef RADIOMODE
        RadioApi_Poll();
#endif
    }
}

void TelemetryTask(void *argument)
{
    (void)argument;

    /* Local shadow of latest data — updated whenever a queue delivers */
    RPiSample_t rpi = {0};
    EncoderSample_t sail_enc = {0};
    //EncoderSample_t flap_enc = {0};

    while (true)
    {

        // get data
        RPi_GetLatest(&rpi);
        Encoder_GetLatest(&sail_enc);
        
        /* ── 3. Format and transmit ──────────────────────────────── */
#ifdef RADIOMODE
        static char buf[TELEMETRY_BUF_LEN];
#else
        char buf[TELEMETRY_BUF_LEN];
#endif
        const int length = snprintf(buf, sizeof(buf),
                 "{"
                 "\"tb\":%d,"
                 "\"tlat\":%d,"
                 "\"tlon\":%d,"
                 "\"tsa\":%d,"
                 "\"tfa\":%d,"
                 "\"tra\":%d,"
                 "\"clat\":%d,"
                 "\"clon\":%d,"
                 "\"cb\":%d,"
                 "\"wa\":%d,"
                 "\"sa\":%d,"
                 "}\r\n",
                 (int)rpi.target_bearing,
                 (int)rpi.target_lat,
                 (int)rpi.target_lon,
                 (int)rpi.target_sail_angle,
                 (int)rpi.target_flap_angle,
                 (int)rpi.target_rudder_angle,
                 (int)rpi.current_lat,
                 (int)rpi.current_lon,
                 (int)rpi.current_bearing,
                 (int)rpi.current_wind_angle,
                 (int)sail_enc.angle);
        if (length > 0 && (size_t)length < sizeof(buf))
            Radio_Send(buf);
#ifdef RADIOMODE
        RadioApi_PrintDiagnostics();
#endif
        /* ── 4. Fixed period ─────────────────────────────────────── */
        osDelay(TELEMETRY_PERIOD_MS);
    }
}

void RpiTransmitTask(void *argument)
{
    WindSample_t sample = {0};

    while (true)
    {

        Wind_GetLatest(&sample);
        snprintf(tx_buf, sizeof(tx_buf),
                 "{\"SensorInput\":[{\"windAngle\":%d}]}\r\n",
                 (int)sample.direction);

        RPi_Send(tx_buf);
        osDelay(500);

    }
}
