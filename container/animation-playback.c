#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted;

static void interrupt(int signal_number) {
    interrupted = signal_number;
}

static int pause_frame(int milliseconds, int *input_closed) {
    if (*input_closed) return 0;
    struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
    int ready = poll(&input, 1, milliseconds);
    if (interrupted) return 128 + interrupted;
    if (ready < 0) return 1;
    if (ready == 0) return 0;
    char key;
    ssize_t count = read(STDIN_FILENO, &key, 1);
    if (count > 0) return 10;
    if (count < 0) return interrupted ? 128 + interrupted : 1;
    *input_closed = 1;
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 3 || (strcmp(argv[1], "line") && strcmp(argv[1], "soh"))) {
        fprintf(stderr, "usage: animation-playback line|soh milliseconds (frames on fd 3)\n");
        return 1;
    }
    char *end;
    long milliseconds = strtol(argv[2], &end, 10);
    if (*end || milliseconds <= 0 || milliseconds > INT_MAX) {
        fprintf(stderr, "animation-playback: invalid dwell in milliseconds\n");
        return 1;
    }
    FILE *frames = fdopen(3, "r");
    if (!frames) {
        perror("animation-playback fd 3");
        return 1;
    }
    struct sigaction action = {.sa_handler = interrupt};
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    struct termios original, reading;
    int terminal = tcgetattr(STDIN_FILENO, &original) == 0;
    if (terminal) {
        reading = original;
        reading.c_lflag &= ~(ICANON | ECHO);
        reading.c_cc[VMIN] = 1;
        reading.c_cc[VTIME] = 0;
        if (tcsetattr(STDIN_FILENO, TCSANOW, &reading) < 0) {
            perror("animation-playback terminal");
            fclose(frames);
            return 1;
        }
    }
    char *frame = NULL;
    size_t capacity = 0;
    int status = 0, input_closed = 0;
    ssize_t length;
    int delimiter = !strcmp(argv[1], "line") ? '\n' : 1;
    while (!interrupted && (length = getdelim(&frame, &capacity, delimiter, frames)) >= 0) {
        if (frame[length - 1] == delimiter) length--;
        else break;
        ssize_t written = 0;
        while (written < length && !interrupted) {
            ssize_t count = write(STDOUT_FILENO, frame + written, length - written);
            if (count > 0) written += count;
            else if (count < 0 && errno == EINTR) continue;
            else {
                perror("animation-playback output");
                status = 1;
                break;
            }
        }
        if (status || interrupted) break;
        status = pause_frame((int)milliseconds, &input_closed);
        if (status) break;
    }
    if (ferror(frames) && !interrupted) {
        perror("animation-playback frames");
        status = 1;
    }
    if (terminal) tcsetattr(STDIN_FILENO, TCSANOW, &original);
    free(frame);
    fclose(frames);
    return interrupted ? 128 + interrupted : status;
}
