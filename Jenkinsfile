// 知萃 CI/CD：Git push → Jenkins → deploy.sh
pipeline {
    agent any

    options {
        timeout(time: 20, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
        // 同一任务的后续构建排队，避免两次发布同时操作生产目录。
        disableConcurrentBuilds()
    }

    stages {
        stage('拉取代码') {
            steps {
                checkout scm
                sh 'git rev-parse --short HEAD'
            }
        }

        stage('部署到服务器') {
            steps {
                sh 'bash /opt/zhicui/deploy/deploy.sh'
            }
        }
    }

    post {
        success { echo '✅ CI/CD 部署成功' }
        failure { echo '❌ CI/CD 部署失败，请查看日志排查' }
    }
}
