#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>

int main(void){
        int fd;
        int value;
        ssize_t rsize;

        fd = open("os2026-1.dat", O_RDONLY);
        if(fd == -1){
                perror("open");
                return 1;
        }

        while( (rsize = read(fd, &value, sizeof(value))) > 0 ){
                if(rsize != sizeof(value)){
                        fprintf(stderr, "read: 4バイト読み込めませんでした\n");
                        return 1;
                }
                printf("%d ", value);
        }

        if(rsize == -1){
                perror("read");
                return 1;
        }
        printf("\n");

        if(close(fd) == -1){
                perror("close");
                return 1;
        }
        return 0;
}