/* USER CODE BEGIN Header */
/**
 ******************************************************************************
 * File Name          : app_freertos.c
 * Description        : FreeRTOS applicative file
 ******************************************************************************
 * @attention
 *
 * Copyright (c) 2026 STMicroelectronics.
 * All rights reserved.
 *
 * This software is licensed under terms that can be found in the LICENSE file
 * in the root directory of this software component.
 * If no LICENSE file comes with this software, it is provided AS-IS.
 *
 ******************************************************************************
 */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "app_freertos.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include "user_i2c.h"
#include "user_uart.h"

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/
/* USER CODE BEGIN Variables */

/* USER CODE END Variables */
/* Definitions for initTask */
osThreadId_t initTaskHandle;
const osThreadAttr_t initTask_attributes = {
  .name = "initTask",
  .priority = (osPriority_t) osPriorityHigh,
  .stack_size = 128 * 4
};
/* Definitions for i2c1Task */
osThreadId_t i2c1TaskHandle;
const osThreadAttr_t i2c1Task_attributes = {
  .name = "i2c1Task",
  .priority = (osPriority_t) osPriorityNormal,
  .stack_size = 128 * 4
};
/* Definitions for i2c2Task */
osThreadId_t i2c2TaskHandle;
const osThreadAttr_t i2c2Task_attributes = {
  .name = "i2c2Task",
  .priority = (osPriority_t) osPriorityNormal,
  .stack_size = 128 * 4
};
/* Definitions for mastAngleTask */
osThreadId_t mastAngleTaskHandle;
const osThreadAttr_t mastAngleTask_attributes = {
  .name = "mastAngleTask",
  .priority = (osPriority_t) osPriorityNormal,
  .stack_size = 128 * 4
};
/* Definitions for uartParserTask */
osThreadId_t uartParserTaskHandle;
const osThreadAttr_t uartParserTask_attributes = {
  .name = "uartParserTask",
  .priority = (osPriority_t) osPriorityNormal,
  .stack_size = 256 * 4
};
/* Definitions for heartbeatTask */
osThreadId_t heartbeatTaskHandle;
const osThreadAttr_t heartbeatTask_attributes = {
  .name = "heartbeatTask",
  .priority = (osPriority_t) osPriorityBelowNormal,
  .stack_size = 128 * 4
};
/* Definitions for debugPrintStringMutex */
osMutexId_t debugPrintStringMutexHandle;
const osMutexAttr_t debugPrintStringMutex_attributes = {
  .name = "debugPrintStringMutex"
};
/* Definitions for i2c1_queue */
osMessageQueueId_t i2c1_queueHandle;
const osMessageQueueAttr_t i2c1_queue_attributes = {
  .name = "i2c1_queue"
};
/* Definitions for i2c2_queue */
osMessageQueueId_t i2c2_queueHandle;
const osMessageQueueAttr_t i2c2_queue_attributes = {
  .name = "i2c2_queue"
};
/* Definitions for mast_angle_queue */
osMessageQueueId_t mast_angle_queueHandle;
const osMessageQueueAttr_t mast_angle_queue_attributes = {
  .name = "mast_angle_queue"
};
/* Definitions for uart_rx_queue */
osMessageQueueId_t uart_rx_queueHandle;
const osMessageQueueAttr_t uart_rx_queue_attributes = {
  .name = "uart_rx_queue"
};
/* Definitions for mastAngleReadComplete */
osSemaphoreId_t mastAngleReadCompleteHandle;
const osSemaphoreAttr_t mastAngleReadComplete_attributes = {
  .name = "mastAngleReadComplete"
};

/* Private function prototypes -----------------------------------------------*/
/* USER CODE BEGIN FunctionPrototypes */

/* USER CODE END FunctionPrototypes */

/* USER CODE BEGIN 1 */
/* Functions needed when configGENERATE_RUN_TIME_STATS is on */
__weak void configureTimerForRunTimeStats(void)
{
  /* Enable TRC */
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;

  /* Reset the cycle counter */
  DWT->CYCCNT = 0;

  /* Enable the cycle counter */
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

__weak unsigned long getRunTimeCounterValue(void)
{
  return DWT->CYCCNT;
}
/* USER CODE END 1 */

/* USER CODE BEGIN PREPOSTSLEEP */
__weak void PreSleepProcessing(uint32_t ulExpectedIdleTime)
{
  /* place for user code */
}

__weak void PostSleepProcessing(uint32_t ulExpectedIdleTime)
{
  /* place for user code */
}
/* USER CODE END PREPOSTSLEEP */

/**
  * @brief  FreeRTOS initialization
  * @param  None
  * @retval None
  */
void MX_FREERTOS_Init(void) {
  /* USER CODE BEGIN Init */

  /* USER CODE END Init */
  /* creation of debugPrintStringMutex */
  debugPrintStringMutexHandle = osMutexNew(&debugPrintStringMutex_attributes);

  /* USER CODE BEGIN RTOS_MUTEX */
  /* add mutexes, ... */
  /* USER CODE END RTOS_MUTEX */
  /* creation of mastAngleReadComplete */
  mastAngleReadCompleteHandle = osSemaphoreNew(1, 1, &mastAngleReadComplete_attributes);

  /* USER CODE BEGIN RTOS_SEMAPHORES */
  /* add semaphores, ... */
  /* USER CODE END RTOS_SEMAPHORES */

  /* USER CODE BEGIN RTOS_TIMERS */
  /* start timers, add new ones, ... */
  /* USER CODE END RTOS_TIMERS */
  /* creation of i2c1_queue */
  i2c1_queueHandle = osMessageQueueNew (8, sizeof(I2C_Transaction_t), &i2c1_queue_attributes);
  /* creation of i2c2_queue */
  i2c2_queueHandle = osMessageQueueNew (8, sizeof(I2C_Transaction_t), &i2c2_queue_attributes);
  /* creation of mast_angle_queue */
  mast_angle_queueHandle = osMessageQueueNew (1, sizeof(uint16_t), &mast_angle_queue_attributes);
  /* creation of uart_rx_queue */
  uart_rx_queueHandle = osMessageQueueNew (32, sizeof(UART_Char_t), &uart_rx_queue_attributes);

  /* USER CODE BEGIN RTOS_QUEUES */
  /* add queues, ... */
  /* USER CODE END RTOS_QUEUES */
  /* creation of initTask */
  initTaskHandle = osThreadNew(InitTask, NULL, &initTask_attributes);

  /* creation of i2c1Task */
  i2c1TaskHandle = osThreadNew(I2CManagerTask, (void *)1, &i2c1Task_attributes);

  /* creation of i2c2Task */
  i2c2TaskHandle = osThreadNew(I2CManagerTask, (void *)2, &i2c2Task_attributes);

  /* creation of mastAngleTask */
  mastAngleTaskHandle = osThreadNew(MastAngleTask, NULL, &mastAngleTask_attributes);

  /* creation of uartParserTask */
  uartParserTaskHandle = osThreadNew(UARTParserTask, NULL, &uartParserTask_attributes);

  /* creation of heartbeatTask */
  heartbeatTaskHandle = osThreadNew(HeartbeatTask, NULL, &heartbeatTask_attributes);

  /* USER CODE BEGIN RTOS_THREADS */
  /* add threads, ... */
  /* USER CODE END RTOS_THREADS */

  /* USER CODE BEGIN RTOS_EVENTS */
  /* add events, ... */
  /* USER CODE END RTOS_EVENTS */

}

/* Private application code --------------------------------------------------*/
/* USER CODE BEGIN Application */

/* USER CODE END Application */

