/** @file user_uart.h
 *
 * @brief Driver code for interfacing with UART peripherals.
 */

#ifndef USER_UART_H
#define USER_UART_H

#include <stdint.h>
#include <stdbool.h>

typedef enum
{
    UART_PORT_1,
    UART_PORT_2,
    UART_PORT_3,
    UART_PORT_4,
    UART_PORT_5,
    UART_PORT_6,
    UART_PORT_7,
    UART_PORT_8,
} UART_Port_t;

typedef struct
{
    UART_Port_t port;
    uint8_t data;
} UART_Char_t;

void User_UART_Init(void);
void Debug_Print_String(const char *string);

bool Radio_Print_String(const char *string);
bool RPi_Print_String(const char *string);

#endif /* USER_UART_H */

/*** end of file ***/