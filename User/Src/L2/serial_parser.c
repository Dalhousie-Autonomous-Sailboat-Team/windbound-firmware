/**
 * @file serial_parser.c
 *
 * @brief Router code for parsing serial data.
 */

/* Module Header */
#include "serial_parser.h"

/* System Headers */
#include "main.h"
#include "cmsis_os2.h"

/* Standard Includes */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <ctype.h>

/* User Includes */
#include "user_uart.h"
#include "L3/command_dispatch.h"
#include "L2/app_types.h"
#include "L2/conversions.h"

extern osMessageQueueId_t uart_rx_queueHandle;
extern osMessageQueueId_t debug_command_queueHandle;
extern osMessageQueueId_t motor_command_queueHandle;

#define BACKSPACE_CHAR '\177'
#define NULL_CHAR '\0'
#define CARRIAGE_RETURN_CHAR '\r'

#define PARSE_STORAGE_LEN 32
#define NMEA_IIMWV "$IIMWV"
#define NMEA_IIMWV_LEN 6

static bool WindVane_Parse_NMEA_Sentence(const char *sentence, WindSample_t *sample)
{

    /* --- Parse fields --- */
    char buf[64];
    strncpy(buf, sentence, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char *saveptr;
    char *token;

    // Field 0: "$IIMWV" — skip
    token = strtok_r(buf, ",", &saveptr);
    if (token == NULL || strncmp(token, "$IIMWV", 6) != 0)
        return false;

    // Field 1: Wind direction
    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->direction = Conversions_StringToFloat(token);

    // Field 2: Reference
    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->reference = token[0];

    // Field 3: Wind speed
    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->speed = Conversions_StringToFloat(token);

    // Field 4: Speed unit
    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->speed_unit = token[0];

    // Field 5: Status
    token = strtok_r(NULL, "*", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->status = token[0];

    /* --- Timestamp --- */
    // sample->timestamp = xTaskGetTickCount();

    return true;
}

static const char *JSON_FindValue(const char *packet, const char *key)
{
    const char *pos = strstr(packet, key);
    if (pos == NULL)
        return NULL;

    // Advance past the key
    pos += strlen(key);

    // Skip any whitespace
    while (*pos == ' ')
        pos++;

    return pos;
}

static bool XBee_Parse_JSON(const char *packet, MotorCommand_t *cmd)
{
    if (packet == NULL || cmd == NULL)
        return false;

    // Validate packet starts with '{' and contains '}'
    if (packet[0] != '{')
        return false;

    if (strchr(packet, '}') == NULL)
        return false;

    // Extract sail_angle
    const char *sa_val = JSON_FindValue(packet, "sa:");
    if (sa_val == NULL)
        return false;
    cmd->sail_angle = Conversions_StringToFloat(sa_val);

    // Extract rud_angle
    const char *ra_val = JSON_FindValue(packet, "ra:");
    if (ra_val == NULL)
        return false;
    cmd->rud_angle = Conversions_StringToFloat(ra_val);

    return true;
}
static void ProcessDebugData(uint8_t data)
{
    static uint8_t index = 0;            /* Index for received data */
    static uint8_t argument_counter = 0; /* Number of parsed tokens */
    static char parse_storage[PARSE_STORAGE_LEN];

    static Command_Message_t command_message;

    switch (data)
    {
    case BACKSPACE_CHAR:
        if (index > 0)
        {
            index--;
            parse_storage[index] = NULL_CHAR;
        }
        break;

    case ' ':
        if (index == 0)
        {
            break; /* Ignore repeated spaces */
        }

        parse_storage[index] = NULL_CHAR;

        if (argument_counter == 0)
        {
            strncpy(command_message.command,
                    parse_storage,
                    MAX_COMMAND_LEN - 1);
            command_message.command[MAX_COMMAND_LEN - 1] = NULL_CHAR;
        }
        else if ((argument_counter - 1) < MAX_COMMAND_ARGUMENTS)
        {
            strncpy(command_message.arguments[argument_counter - 1],
                    parse_storage,
                    MAX_ARGUMENT_LEN - 1);
            command_message.arguments[argument_counter - 1][MAX_ARGUMENT_LEN - 1] = NULL_CHAR;
        }

        argument_counter++;
        index = 0;
        break;

    case CARRIAGE_RETURN_CHAR:
        parse_storage[index] = NULL_CHAR;

        if (index > 0 || argument_counter == 0)
        {
            if (argument_counter == 0)
            {
                strncpy(command_message.command,
                        parse_storage,
                        MAX_COMMAND_LEN - 1);
                command_message.command[MAX_COMMAND_LEN - 1] = NULL_CHAR;
            }
            else if ((argument_counter - 1) < MAX_COMMAND_ARGUMENTS)
            {
                strncpy(command_message.arguments[argument_counter - 1],
                        parse_storage,
                        MAX_ARGUMENT_LEN - 1);
                command_message.arguments[argument_counter - 1][MAX_ARGUMENT_LEN - 1] = NULL_CHAR;
            }

            command_message.arg_count = argument_counter;
            Dispatch_Command(&command_message);
        }

        /* Reset parser state */
        memset(&command_message, 0, sizeof(command_message));
        argument_counter = 0;
        index = 0;
        break;

    default:
        if (index < (PARSE_STORAGE_LEN - 1))
        {
            parse_storage[index] = (char)tolower((unsigned char)data);
            index++;
        }

        break;
    }
}

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
            if (WindVane_Parse_NMEA_Sentence(nmea_sentence, &sample))
            {
                // WindVaneBuf_Push(&sample);
                //  For now, just print the parsed data
                //  printf("Parsed Wind Sample: Direction=%.1f%c, Speed=%.1f%c, Status=%c\n",
                //         sample.direction, sample.reference,
                //         sample.speed, sample.speed_unit,
                //         sample.status);
                Debug_Print_String("Something parsed from windvane\r\n");
            }
        }

        index = 0;
    }
}

static void ProcessXbeeData(uint8_t data)
{
    /* Future implementation for UART8 data from Xbee */
    // Debug_Print_String("Received data from Xbee\r\n");

    static char xbee_packet[64];
    static uint8_t index = 0;
    static bool collecting = false;

    // Start collecting on '{'
    if (data == '{')
    {
        index = 0;
        collecting = true;
    }

    if (!collecting)
        return;

    // Overflow protection
    if (index >= sizeof(xbee_packet) - 1)
    {
        collecting = false;
        index = 0;
        return;
    }

    xbee_packet[index++] = data;

    // End of packet on '\n'
    if (data == '\n')
    {
        collecting = false;
        xbee_packet[index] = '\0';
        index = 0;

        MotorCommand_t cmd;
        if (XBee_Parse_JSON(xbee_packet, &cmd))
        {
            osMessageQueuePut(motor_command_queueHandle, &cmd, 0, 0);
        }
    }
}

void UARTParserTask(void *argument)
{
    UART_Char_t uart_char;
    User_UART_Init();
    while (true)
    {
        osMessageQueueGet(uart_rx_queueHandle, &uart_char, NULL, osWaitForever);
        switch (uart_char.port)
        {
        case UART_PORT_4: // data from PC debug
            /* Handle data from UART4 */
            ProcessDebugData(uart_char.data);
            break;

        case UART_PORT_3: // data from windvane
            /* Future implementation for UART3 */
            ProcessWindvaneData(uart_char.data);
            break;

        case UART_PORT_8: // data from radio
            /* Future implementation for UART8 */
            // ProcessRadioData(uart_char.data);
            ProcessXbeeData(uart_char.data);
            break;

        default:
            continue;
        }
    }
}