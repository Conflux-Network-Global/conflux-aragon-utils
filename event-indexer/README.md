# Getting started

For running the indexer locally, you can set up MySQL using Docker:

```
$ docker pull mysql/mysql-server:latest

$ docker run --detach --name=mysql --env="MYSQL_ROOT_PASSWORD=password" --publish 3306:3306 mysql/mysql-server:latest
$ docker exec -it mysql mysql -uroot -p

mysql> create user 'user'@'localhost' identified by 'password';
mysql> grant all privileges on *.* to 'user'@'localhost';
mysql> create user 'user'@'%' identified by 'password';
mysql> grant all privileges on *.* to 'user'@'%';

mysql> create database db;
mysql> use db;
mysql> create table latest ( name varchar(50), address varchar(50), earliest int, latest int );
mysql> create table events ( epoch int, block_hash char(66), address varchar(100), topic0 char(66), topic1 char(66), topic2 char(66), topic3 char(66), raw varchar(10000) );
```

Then, run the indexer:

```
$ node src/index.js
```