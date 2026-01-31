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

extern osMessageQueueId_t uart_rx_queueHandle;
extern osMessageQueueId_t debug_command_queueHandle;

#define BACKSPACE_CHAR '\177'
#define NULL_CHAR '\0'
#define CARRIAGE_RETURN_CHAR '\r'

#define PARSE_STORAGE_LEN 32

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

/**
 * @brief UART Serial Data Parser Task
 *
 * @param argument Pointer to the I2C bus number (1 or 2)
 */
void UARTParserTask(void *argument)
{
    UART_Char_t uart_char;
    User_UART_Init();
    while (true)
    {
        osMessageQueueGet(uart_rx_queueHandle, &uart_char, NULL, osWaitForever);
        switch (uart_char.port)
        {
        case UART_PORT_4:
            /* Handle data from UART4 */
            ProcessDebugData(uart_char.data);
            break;

        default:
            continue;
        }
    }
}