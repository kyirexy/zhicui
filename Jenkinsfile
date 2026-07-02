// VideoCapsule / 知萃 CI/CD 流水线
// GitHub push → Jenkins 触发 → deploy.sh 自动部署
pipeline {
    agent any

    options {
        timeout(time: 15, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
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
        failure { echo '❌ CI/CD 部署失败,查看日志排查' }
    }
}
