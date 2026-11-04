#!/usr/bin/python3
"""Bounded workspace archives. Never extract links, devices or outside the home."""
import os, sys, tarfile, tempfile, shutil, pathlib, json
LIMIT = 512 * 1024 * 1024
COUNT = 50000
HOME = pathlib.Path('/home/outpost')
EXCLUDED = {'.Xauthority','profile/.parentlock','profile/lock','profile/SingletonLock','profile/SingletonSocket','profile/SingletonCookie'}

def export(destination):
    size = count = 0
    with tarfile.open(destination, 'w') as archive:
        for root, directories, files in os.walk(HOME, followlinks=False):
            directories[:] = [d for d in directories if pathlib.Path(root,d).relative_to(HOME).as_posix() not in {'profile/cache2','.cache'}]
            for name in directories:
                folder = pathlib.Path(root,name)
                if folder.is_symlink(): raise ValueError('Move symbolic links out of the workspace before exporting: '+str(folder.relative_to(HOME)))
                count += 1
                if count > COUNT: raise ValueError('Workspace exceeds archive limits')
                archive.add(folder,arcname=str(folder.relative_to(HOME)),recursive=False)
            for name in files:
                file = pathlib.Path(root,name)
                if file.relative_to(HOME).as_posix() in EXCLUDED: continue
                if file.is_symlink() or not file.is_file(): raise ValueError('Unsupported workspace file: '+str(file.relative_to(HOME)))
                size += file.stat().st_size; count += 1
                if size > LIMIT or count > COUNT: raise ValueError('Workspace exceeds archive limits')
                archive.add(file, arcname=str(file.relative_to(HOME)), recursive=False)

def restore(source):
    if os.path.getsize(source) > LIMIT + COUNT * 2048: raise ValueError('Archive too large')
    stage = pathlib.Path(tempfile.mkdtemp(prefix='.outpost-import-',dir=HOME.parent))
    backup = stage.with_name(stage.name+'-previous')
    try:
        size = count = 0; seen = set()
        with tarfile.open(source, 'r:') as archive:
            for item in archive:
                name = item.name
                p = pathlib.PurePosixPath(name)
                if not name or len(name.encode())>4096 or len(p.parts)>64 or any(len(x.encode())>255 for x in p.parts) or '\\' in name or '\x00' in name or p.is_absolute() or any(x in {'','..','.'} for x in name.split('/')): raise ValueError('Unsafe archive path')
                if name in seen or name in EXCLUDED: raise ValueError('Duplicate or reserved archive path')
                if not item.isfile() and not item.isdir(): raise ValueError('Links and special files are not accepted')
                seen.add(name); count += 1; size += item.size
                if size > LIMIT or count > COUNT or item.size < 0: raise ValueError('Workspace exceeds archive limits')
                target = stage.joinpath(*p.parts)
                if item.isdir(): target.mkdir(parents=True,exist_ok=True)
                else:
                    target.parent.mkdir(parents=True,exist_ok=True)
                    with archive.extractfile(item) as incoming, open(target,'xb') as outgoing:
                        shutil.copyfileobj(incoming,outgoing,1024*1024)
                    os.chmod(target, 0o700 if item.mode & 0o111 else 0o600)
                os.chown(target,1000,1000)
        for root, dirs, files in os.walk(stage): os.chown(root,1000,1000); os.chmod(root,0o700)
        os.replace(HOME,backup)
        try: os.replace(stage,HOME)
        except BaseException:
            os.replace(backup,HOME); raise
        shutil.rmtree(backup)
    finally:
        if stage.exists(): shutil.rmtree(stage)

def files(request):
    data = json.loads(pathlib.Path(request).read_text())
    relative = data.get('path','')
    if not isinstance(relative,str) or pathlib.PurePosixPath(relative).is_absolute(): raise ValueError('Invalid workspace path')
    target = (HOME / relative).resolve()
    if not target.is_relative_to(HOME.resolve()): raise ValueError('Path leaves workspace')
    action = data['action']
    if action == 'list':
        result=[]
        for item in sorted(target.iterdir(),key=lambda p:(not p.is_dir(),p.name.lower())):
            if item.is_symlink() or item.relative_to(HOME).as_posix() in EXCLUDED: continue
            result.append({'name':item.name,'directory':item.is_dir(),'bytes':item.stat().st_size})
            if len(result)>5000: raise ValueError('Too many entries in this folder')
        pathlib.Path('/opt/outpost/files.json').write_text(json.dumps(result))
    elif action == 'download':
        if not target.is_file() or target.stat().st_size > 64*1024*1024: raise ValueError('Choose a file smaller than 64 MB')
        shutil.copyfile(target,'/opt/outpost/download.bin')
    elif action in {'upload','mkdir'}:
        name=data.get('name','')
        if not isinstance(name,str) or not name or name in {'.','..'} or '/' in name or '\\' in name or '\x00' in name: raise ValueError('Invalid file name')
        destination=target/name
        if destination.exists() or destination.is_symlink(): raise ValueError('That name already exists')
        if action == 'mkdir': destination.mkdir(mode=0o700)
        else:
            source=pathlib.Path('/opt/outpost/upload.bin')
            if source.stat().st_size > 64*1024*1024: raise ValueError('Upload exceeds 64 MB')
            with open(destination,'xb') as outgoing, open(source,'rb') as incoming: shutil.copyfileobj(incoming,outgoing)
            os.chmod(destination,0o600)
        os.chown(destination,1000,1000)
    else: raise ValueError('Unknown file action')

if __name__ == '__main__':
    try:
        if sys.argv[1] == 'export': export(sys.argv[2])
        elif sys.argv[1] == 'restore': restore(sys.argv[2])
        elif sys.argv[1] == 'files': files(sys.argv[2])
        else: raise ValueError('Unknown operation')
    except Exception as error:
        print(str(error),file=sys.stderr); sys.exit(1)
