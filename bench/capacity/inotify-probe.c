#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    if (!strcmp(argv[1], "quota")) {
        int fds[1024], count = 0, error = 0;
        char userns[80] = {0};
        struct rlimit limit;
        if (getrlimit(RLIMIT_NOFILE, &limit) < 0) return 1;
        if (readlink("/proc/self/ns/user", userns, sizeof(userns) - 1) < 0) return 1;
        while (count < 1024) {
            int fd = inotify_init1(IN_CLOEXEC);
            if (fd < 0) { error = errno; break; }
            fds[count++] = fd;
        }
        for (int i = 0; i < count; i++) close(fds[i]);
        printf("{\"uid\":%u,\"euid\":%u,\"userns\":\"%s\",\"available_instances\":%d,\"errno\":%d,\"nofile_soft\":%llu}\n",
            getuid(), geteuid(), userns, count, error, (unsigned long long)limit.rlim_cur);
        return error == EMFILE ? 0 : 1;
    }
    if (!strcmp(argv[1], "hold")) {
        for (int i = 0; i < 8; i++) {
            if (inotify_init1(IN_CLOEXEC) < 0) { perror("inotify_init1"); return 1; }
        }
        puts("HOLDING 8 instances");
        fflush(stdout);
        sleep(20);
        return 0;
    }
    if (!strcmp(argv[1], "idle")) {
        sleep(900);
        return 0;
    }
    if (!strcmp(argv[1], "oom")) {
        pid_t child = fork();
        if (child < 0) { perror("fork"); return 1; }
        if (!child) {
            for (int i = 0; i < 1024; i++) {
                volatile unsigned char *block = malloc(1024 * 1024);
                if (!block) _exit(3);
                for (int p = 0; p < 1024 * 1024; p += 4096) block[p] = 1;
            }
            _exit(4);
        }
        int status;
        if (waitpid(child, &status, 0) != child) return 1;
        printf("child_signal=%d\n", WIFSIGNALED(status) ? WTERMSIG(status) : 0);
        FILE *events = fopen("/sys/fs/cgroup/memory.events", "r");
        if (!events) { perror("memory.events"); return 1; }
        char row[160];
        while (fgets(row, sizeof(row), events)) fputs(row, stdout);
        fclose(events);
        fflush(stdout);
        sleep(5);
        return WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL ? 0 : 1;
    }
    return 2;
}
