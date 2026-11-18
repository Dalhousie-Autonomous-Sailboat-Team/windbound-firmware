#include "app_protocol.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

#if defined(_MSC_VER)
#define strtok_r strtok_s
#endif

bool AppProtocol_ParseWindNmea(const char *sentence, WindSample_t *sample)
{
    if (sentence == NULL || sample == NULL)
        return false;

    char buf[64];
    strncpy(buf, sentence, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char *saveptr;
    char *token;

    token = strtok_r(buf, ",", &saveptr);
    if (token == NULL || strncmp(token, "$IIMWV", 6) != 0)
        return false;

    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->direction = StringToFloat(token);

    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->reference = token[0];

    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->speed = StringToFloat(token);

    token = strtok_r(NULL, ",", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->speed_unit = token[0];

    token = strtok_r(NULL, "*", &saveptr);
    if (token == NULL || *token == '\0')
        return false;
    sample->status = token[0];

    return true;
}

static const char *JSON_FindValue(const char *packet, const char *key)
{
    if (packet == NULL || key == NULL)
        return NULL;

    const char *pos = packet;

    while ((pos = strstr(pos, key)) != NULL)
    {
        if (pos > packet)
        {
            const char *prev = pos - 1;
            while (prev > packet && *prev == ' ')
                prev--;

            char c = *prev;
            if (c != '"' && c != '{' && c != ',')
            {
                pos++;
                continue;
            }
        }

        pos += strlen(key);
        while (*pos == ' ')
            pos++;

        return pos;
    }

    return NULL;
}

bool AppProtocol_ParseXbeeCommand(const char *packet, XbeeCommand_t *cmd)
{
    if (packet == NULL || cmd == NULL)
        return false;

    if (packet[0] != '{' || strchr(packet, '}') == NULL)
        return false;

    const char *sa_val = JSON_FindValue(packet, "sa:");
    if (sa_val == NULL)
        return false;
    cmd->sail_angle = StringToFloat(sa_val);

    const char *ra_val = JSON_FindValue(packet, "ra:");
    if (ra_val == NULL)
        return false;
    cmd->rud_angle = StringToFloat(ra_val);

    return true;
}

bool AppProtocol_ParseRpiSample(const char *packet, RPiSample_t *rpi)
{
    if (packet == NULL || rpi == NULL)
        return false;

    const char *obj = strchr(packet, '[');
    if (obj == NULL)
        return false;
    obj = strchr(obj, '{');
    if (obj == NULL || strchr(obj, '}') == NULL)
        return false;

    const char *val;

    val = JSON_FindValue(obj, "targetBearing\":");
    if (val == NULL)
        return false;
    rpi->target_bearing = StringToFloat(val);

    val = JSON_FindValue(obj, "waypointLat\":");
    if (val == NULL)
        return false;
    rpi->target_lat = StringToFloat(val);

    val = JSON_FindValue(obj, "waypointLon\":");
    if (val == NULL)
        return false;
    rpi->target_lon = StringToFloat(val);

    val = JSON_FindValue(obj, "targetSailAngle\":");
    if (val == NULL)
        return false;
    rpi->target_sail_angle = StringToFloat(val);

    val = JSON_FindValue(obj, "targetFlapAngle\":");
    if (val == NULL)
        return false;
    rpi->target_flap_angle = StringToFloat(val);

    val = JSON_FindValue(obj, "targetRudderAngle\":");
    if (val == NULL)
        return false;
    rpi->target_rudder_angle = StringToFloat(val);

    val = JSON_FindValue(obj, "latitude\":");
    if (val == NULL)
        return false;
    rpi->current_lat = StringToFloat(val);

    val = JSON_FindValue(obj, "longitude\":");
    if (val == NULL)
        return false;
    rpi->current_lon = StringToFloat(val);

    val = JSON_FindValue(obj, "headingAngle\":");
    if (val == NULL)
        return false;
    rpi->current_bearing = StringToFloat(val);

    val = JSON_FindValue(obj, "windAngle\":");
    if (val == NULL)
        return false;
    rpi->current_wind_angle = StringToFloat(val);

    return true;
}

bool AppProtocol_FormatTelemetry(char *buf, size_t len, const RPiSample_t *rpi,
                                 const EncoderSample_t *sail_enc)
{
    if (buf == NULL || len == 0 || rpi == NULL || sail_enc == NULL)
        return false;

    int written = snprintf(buf, len,
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
                           (int)rpi->target_bearing,
                           (int)rpi->target_lat,
                           (int)rpi->target_lon,
                           (int)rpi->target_sail_angle,
                           (int)rpi->target_flap_angle,
                           (int)rpi->target_rudder_angle,
                           (int)rpi->current_lat,
                           (int)rpi->current_lon,
                           (int)rpi->current_bearing,
                           (int)rpi->current_wind_angle,
                           (int)sail_enc->angle);

    return written > 0 && (size_t)written < len;
}

float StringToFloat(const char *str)
{
    /* Plain decimal with an optional exponent ("-63.553012", "1.2e-05").
     * Every digit counts: the old version kept four decimals, about 11 m of
     * latitude, and stopped at an 'e'. Accumulates in double; the result is
     * float, good to about half a metre at Halifax's latitude. */
    if (str == NULL || *str == '\0')
        return 0.0f;

    bool negative = false;
    if (*str == '-' || *str == '+')
    {
        negative = (*str == '-');
        str++;
    }

    double value = 0.0;
    while (*str >= '0' && *str <= '9')
    {
        value = value * 10.0 + (double)(*str - '0');
        str++;
    }
    if (*str == '.')
    {
        double scale = 0.1;
        str++;
        while (*str >= '0' && *str <= '9')
        {
            value += (double)(*str - '0') * scale;
            scale *= 0.1;
            str++;
        }
    }
    if (*str == 'e' || *str == 'E')
    {
        bool negative_exponent = false;
        int exponent = 0;
        str++;
        if (*str == '-' || *str == '+')
        {
            negative_exponent = (*str == '-');
            str++;
        }
        while (*str >= '0' && *str <= '9' && exponent < 64)
        {
            exponent = exponent * 10 + (*str - '0');
            str++;
        }
        while (exponent-- > 0)
            value = negative_exponent ? value / 10.0 : value * 10.0;
    }
    return (float)(negative ? -value : value);
}

bool AppProtocol_FormatSensorInput(char *buf, size_t len, const WindSample_t *wind,
                                   uint32_t now_ms)
{
    if (buf == NULL || wind == NULL || len == 0)
        return false;

    /* $IIMWV speed units: N knots, M m/s, K km/h, S statute mph. */
    float speed = wind->speed;
    switch (wind->speed_unit)
    {
    case 'N': speed *= 0.514444f; break;
    case 'K': speed /= 3.6f; break;
    case 'S': speed *= 0.44704f; break;
    default: break;
    }
    int tenths = speed > 0.0f ? (int)(speed * 10.0f + 0.5f) : 0;
    bool valid = wind->status == 'A' && (uint32_t)(now_ms - wind->timestamp) < WIND_STALE_MS;
    char reference = (wind->reference == 'T') ? 'T' : 'R';

    int written = snprintf(buf, len,
                           "{\"SensorInput\":[{\"windAngle\":%d,\"windSpeed\":%d.%d,"
                           "\"windRef\":\"%c\",\"windValid\":%d}]}\r\n",
                           (int)wind->direction, tenths / 10, tenths % 10, reference, valid ? 1 : 0);
    return written > 0 && (size_t)written < len;
}

void FloatToString(float value, char *buf)
{
    int rounded = (int)(value < 0 ? value - 0.5f : value + 0.5f);
    sprintf(buf, "%d", rounded);
}
