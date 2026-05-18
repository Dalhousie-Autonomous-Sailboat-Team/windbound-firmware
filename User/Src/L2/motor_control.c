#include "L2/motor_control.h"

#include "pid.h"
#include "L2/encoder.h"
#include "L2/rpi.h"
#include "cmsis_os.h"
#include "tim.h"
#include "L1/user_uart.h"
#include <stdio.h>
#include "L3/boat_mode.h"

extern osMessageQueueId_t wind_queueHandle;
extern osMessageQueueId_t xbee_command_queueHandle;
// Bang Bang control

#define SAIL_TASK_PERIOD_MS 50
#define SAIL_DEAD_BAND_DEG 20.0f
#define MOTOR_FULL 12800
#define MOTOR_OFF 0
#define RUDDER_TASK_PERIOD_MS 20

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
    RPiSample_t rpi_sample = {0};
    XbeeCommand_t xbee_cmd = {0};
    float target_sail_angle = 0.0f;
    char buf[64];

    while (true)
    {

        if (boat_mode == MODE_WIND_FOLLOWING)
        {
            osMessageQueueGet(wind_queueHandle, &wind, NULL, osWaitForever);
            target_sail_angle = wind.direction;
        }
        else if (boat_mode == MODE_AUTONOMOUS)
        {
            RPi_GetLatest(&rpi_sample);

            target_sail_angle = rpi_sample.target_sail_angle;
        }
        else if (boat_mode == MODE_MANUAL)
        {
            /* MODE_MANUAL: block until XBee sends a packet — ignore RPi and wind entirely */
            osMessageQueueGet(xbee_command_queueHandle, &xbee_cmd, NULL, osWaitForever);
            target_sail_angle = xbee_cmd.sail_angle;
        }

        /* ── 2. Read current sail position ───────────────────────────── */
        Encoder_GetLatest(&enc);

        sprintf(buf, "windvane angle =%d, encoder angle =%d\r\n", (int)wind.direction, (int)enc.angle);
        Debug_Print_String(buf);

        /* ── 3. Shortest-path error ──────────────────────────────────── */
        float error = wrap_error(target_sail_angle - enc.angle);

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
        // osDelay(100);
    }
}

void RudderMotorTask(void *argument)
{
    (void)argument;

    RPiSample_t rpi_cmd = {0};
    XbeeCommand_t xbee_cmd = {0};
    float rudder_angle = 0.0f;

    while (true)
    {
        if (boat_mode == MODE_AUTONOMOUS)
        {
            /* Get RPi rudder angle as default */
            RPi_GetLatest(&rpi_cmd);
            rudder_angle = rpi_cmd.target_rudder_angle;

            /* Override if XBee is sending anything non-zero */
            if (osMessageQueueGet(xbee_command_queueHandle, &xbee_cmd, NULL, 0) == osOK)
            {
                if (xbee_cmd.rud_angle != 0.0f)
                    rudder_angle = xbee_cmd.rud_angle;
            }
        }
        else /* MODE_MANUAL */
        {
            /* Block until XBee sends a packet — ignore RPi entirely */
            osMessageQueueGet(xbee_command_queueHandle, &xbee_cmd, NULL, osWaitForever);
            rudder_angle = xbee_cmd.rud_angle;
        }

        // /* Map -45 to +45 → 1000 to 2000 µs */
        // uint16_t pulse = (uint16_t)(1500.0f + (rudder_angle / 45.0f) * 500.0f);
        // __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, pulse);

        osDelay(RUDDER_TASK_PERIOD_MS);
    }
}