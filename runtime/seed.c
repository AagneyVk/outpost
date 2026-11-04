#include <fcntl.h>
#include <linux/random.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <unistd.h>
int main(void) {
 struct { int entropy_count, buf_size; unsigned char bytes[32]; } pool={256,32,{0}};
 int source=open("/etc/outpost.seed",O_RDONLY); if(source<0)return 1;
 if(read(source,pool.bytes,32)!=32){close(source);return 2;} close(source);
 int nonzero=0;for(int i=0;i<32;i++)nonzero|=pool.bytes[i];if(!nonzero)return 3;
 int random=open("/dev/random",O_RDWR);if(random<0)return 4;
 int result=ioctl(random,RNDADDENTROPY,&pool);close(random);
 volatile unsigned char *wipe=pool.bytes;for(int i=0;i<32;i++)wipe[i]=0;
 if(result)return 5;unlink("/etc/outpost.seed");return 0;
}
