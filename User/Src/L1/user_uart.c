/**
 * @file user_uart.c
 *
 * @brief Driver code for interfacing with UART peripherals.
 */

/* Module Header */
#include "user_uart.h"

/* System Headers */
#include "main.h"
#include "cmsis_os2.h"

/* Standard Includes */
#include <stdint.h>
#include <stdbool.h>

/* User Includes */
#include "user_main.h"

#define DEBUG_PORT UART_PORT_4

extern UART_HandleTypeDef huart1;
extern UART_HandleTypeDef huart2;
extern UART_HandleTypeDef huart3;
extern UART_HandleTypeDef huart4;
extern UART_HandleTypeDef huart5;
extern UART_HandleTypeDef huart6;
extern UART_HandleTypeDef huart7;
extern UART_HandleTypeDef huart8;

extern osMessageQueueId_t uart_rx_queueHandle;
extern osMutexId_t debugPrintStringMutexHandle;

uint8_t uart1_rx_byte;
uint8_t uart2_rx_byte;
uint8_t uart3_rx_byte;
uint8_t uart4_rx_byte;
uint8_t uart5_rx_byte;
uint8_t uart6_rx_byte;
uint8_t uart7_rx_byte;
uint8_t uart8_rx_byte;

UART_HandleTypeDef *uart_handle_lookup[] = {
    &huart1,
    &huart2,
    &huart3,
    &huart4,
    &huart5,
    &huart6,
    &huart7,
    &huart8,
};

/**
 * @brief Initializes UART peripherals for interrupt-driven reception.
 */
void User_UART_Init(void)
{
    /* Start Interrupt Character Reception for all UART ports */
    HAL_UART_Receive_IT(&huart4, &uart4_rx_byte, 1);
    HAL_UART_Receive_IT(&huart3, &uart3_rx_byte, 1);
    HAL_UART_Receive_IT(&huart8, &uart8_rx_byte, 1);
    //HAL_UART_Receive_IT(&huart1, &uart1_rx_byte, 1);
}

/**
 * @brief Local function to print a char to the specified UART port.
 * @param ch
 * @param port
 */
static void Print_Char_Local(char ch, UART_Port_t port)
{
    UART_HandleTypeDef *huart = uart_handle_lookup[(int)port];
    HAL_UART_Transmit(huart, (uint8_t *)&ch, 1, HAL_MAX_DELAY);
}

/**
 * @brief Local function to print a string to a specified UART port.
 * @param string
 * @param port
 */
static void Print_String_Local(const char *string, UART_Port_t port)
{
    while (*string != '\0')
    {
        Print_Char_Local(*string, port);
        string++;
    }
}

/**
 * @brief Thread-safe function to print a string to the debug UART port.
 * @param string
 */
void Debug_Print_String(const char *string)
{
    osMutexAcquire(debugPrintStringMutexHandle, osWaitForever);
    Print_String_Local(string, DEBUG_PORT);
    osMutexRelease(debugPrintStringMutexHandle);
}



/**
 * @brief Receive Complete Callback
 * @param huart Pointer to UART handle
 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
    if (huart == &huart4) // character from PC debug
    {
        UART_Char_t uart_char;
        uart_char.port = UART_PORT_4;
        uart_char.data = uart4_rx_byte;
        osMessageQueuePut(uart_rx_queueHandle, &uart_char, 0, 0);
        /* Restart Interrupt Character Reception for UART4 */
        HAL_UART_Receive_IT(huart, &uart4_rx_byte, 1);
        /* Echo byte back to host */
       // HAL_UART_Transmit(huart, &uart4_rx_byte, 1, 0);
    }
    else if (huart == &huart3) // character from windvane
    {
        UART_Char_t uart_char;
        uart_char.port = UART_PORT_3;
        uart_char.data = uart3_rx_byte;
        osMessageQueuePut(uart_rx_queueHandle, &uart_char, 0, 0);
        /* Restart Interrupt Character Reception for UART3 */
        HAL_UART_Receive_IT(huart, &uart3_rx_byte, 1);
        //HAL_UART_Transmit(huart, &uart3_rx_byte, 1, 0);

    }

    else if (huart == &huart8) // character radio 
    {
        UART_Char_t uart_char;
        uart_char.port = UART_PORT_8;
        uart_char.data = uart8_rx_byte;
        osMessageQueuePut(uart_rx_queueHandle, &uart_char, 0, 0);
        /* Restart Interrupt Character Reception for UART8 */
        HAL_UART_Receive_IT(huart, &uart8_rx_byte, 1);
    }

    else
    {
    };
}

/**
 * @brief UART Error Callback
 * @param huart
 */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
    if (huart == &huart4)
    {
        /* Restart Interrupt Character Reception for UART4 */
        HAL_UART_Receive_IT(huart, &uart4_rx_byte, 1);
    }
}