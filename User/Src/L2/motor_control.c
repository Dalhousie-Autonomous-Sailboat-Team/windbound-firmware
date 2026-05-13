#include "L2/motor_control.h"

#include "pid.h"
#include "L2/encoder.h"
#include "L2/rpi.h"
#include "cmsis_os.h"
#include "tim.h"
#include "L1/user_uart.h"
#include <stdio.h>


extern osMessageQueueId_t wind_queueHandle;

// /* Tuning — adjust these during testing */
// #define SAIL_KP 1.0f
// #define SAIL_KI 0.01f
// #define SAIL_KD 0.1f

// /* Output maps directly to PWM duty cycle percent */
// #define SAIL_OUTPUT_MIN -100.0f
// #define SAIL_OUTPUT_MAX 100.0f

// /* Integral clamp — prevents windup before motor starts moving */
// #define SAIL_INTEGRAL_MIN -50.0f
// #define SAIL_INTEGRAL_MAX 50.0f

// /* Dead band — don't drive motor if error is within this range */
// #define SAIL_DEAD_BAND_DEG 1.0f

// #define SAIL_TASK_PERIOD_MS 50 /* 20 Hz control loop */

// void SailMotorTask(void *argument)
// {
//     (void)argument;

//     PID_t pid;
//     PID_Init(&pid,
//              SAIL_KP, SAIL_KI, SAIL_KD,
//              SAIL_OUTPUT_MIN, SAIL_OUTPUT_MAX,
//              SAIL_INTEGRAL_MIN, SAIL_INTEGRAL_MAX);

//     RPiSample_t rpi = {0};
//     EncoderSample_t enc = {0};

//     float dt = SAIL_TASK_PERIOD_MS / 1000.0f; /* fixed dt in seconds */

//     uint32_t tick = osKernelGetTickCount();

//     while (true)
//     {
//         /* ── 1. Read setpoint and process variable ───────────────────── */
//         RPi_GetLatest(&rpi);
//         Encoder_GetLatest(&enc);

//         /* ── 2. Compute error ────────────────────────────────────────── */
//         float error = rpi.current_wind_angle - (float)enc.angle;

//         /* ── 3. Dead band — stop driving if close enough ─────────────── */
//         if (error > -SAIL_DEAD_BAND_DEG && error < SAIL_DEAD_BAND_DEG)
//         {
//             // Motor_SetPWM(SAIL_MOTOR, 0.0f);
//             PID_Reset(&pid); /* clear integral so it doesn't wind up */
//             osDelayUntil(tick += SAIL_TASK_PERIOD_MS);
//             continue;
//         }

//         /* ── 4. PID update ───────────────────────────────────────────── */
//         float output = PID_Update(&pid,
//                                   rpi.target_sail_angle,
//                                   (float)enc.angle,
//                                   dt);

//         /* ── 5. Drive motor ──────────────────────────────────────────── */
//         // Motor_SetPWM(SAIL_MOTOR, output);

//         /* ── 6. Fixed period ─────────────────────────────────────────── */
//         osDelayUntil(tick += SAIL_TASK_PERIOD_MS);
//     }
// }

// BANG BANG CONTROL FOR TESTING

#define SAIL_TASK_PERIOD_MS 50
#define SAIL_DEAD_BAND_DEG 20.0f
#define MOTOR_FULL 12800
#define MOTOR_OFF 0

static float wrap_error(float error)
{
    while (error > 180.0f)
        error -= 360.0f;
    while (error < -180.0f)
        error += 360.0f;
    return error;
}

void SailMotorTask(void *argument)
{
    (void)argument;

    WindSample_t wind = {0};
    EncoderSample_t enc = {0};
    char buf[64];
   // __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, 12800);



    while (true)
    {
        /* ── 1. Wait for a new wind sample ───────────────────────────── */
        osMessageQueueGet(wind_queueHandle, &wind, NULL, osWaitForever);


    
        /* ── 2. Read current sail position ───────────────────────────── */
        Encoder_GetLatest(&enc);


        sprintf(buf, "windvane angle =%d, encoder angle =%d\r\n",(int)wind.direction, (int)enc.angle);
        Debug_Print_String(buf);


        /* ── 3. Shortest-path error ──────────────────────────────────── */
        float error = wrap_error(wind.direction - enc.angle);

        /* ── 4. Bang-bang motor control ──────────────────────────────── */
        if (error > SAIL_DEAD_BAND_DEG)
        {
            /* Sail is behind — drive forward */
            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, 12800);
            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_2, 0);
        }
        else if (error < -SAIL_DEAD_BAND_DEG)
        {
            /* Sail is ahead — drive backward */
            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, 0);
            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_2, 12800);
        
        }
        else
        {
            /* Within ±20° — stop */
            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, 0);
            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_2, 0);
        }
        //osDelay(100); 

    }
}